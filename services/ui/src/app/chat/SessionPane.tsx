'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import EventCard, { type AgentEvent } from '@/app/agents/[id]/EventCard'

const MAX_EVENTS = 200
const TOOL_FILTERS = ['All', 'Shell', 'Runtime', 'Inference'] as const
type ToolFilter = typeof TOOL_FILTERS[number]

interface Props {
  threadId: string
}

export default function SessionPane({ threadId }: Props) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [filter, setFilter] = useState<ToolFilter>('All')
  const [autoScroll, setAutoScroll] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(nearBottom)
  }, [])

  useEffect(() => {
    const es = new EventSource(`/api/chat/${threadId}/events?follow=true&tail=20`)

    es.onmessage = (msg) => {
      try {
        const event: AgentEvent = JSON.parse(msg.data)
        setEvents(prev => {
          const next = [...prev, event]
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        })
      } catch {
        // skip
      }
    }

    es.addEventListener('end', () => es.close())
    es.addEventListener('error', () => {
      // EventSource auto-reconnects
    })

    return () => es.close()
  }, [threadId])

  useEffect(() => {
    if (autoScroll && typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [events, autoScroll])

  const filtered =
    filter === 'All'
      ? events
      : events.filter(e => e.tool === filter.toLowerCase())

  return (
    <div className="flex flex-col h-full" data-testid="session-pane">
      <div className="p-3 border-b border-navy-700 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Live Session</h3>
        <div className="flex items-center gap-1">
          {TOOL_FILTERS.map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
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
        className="flex-1 overflow-y-auto p-3 space-y-2"
      >
        {filtered.length === 0 ? (
          <p className="text-sm text-mountain-500 text-center py-4" data-testid="no-events">
            {events.length === 0 ? 'Waiting for events...' : 'No events match filter.'}
          </p>
        ) : (
          filtered.map(event => (
            <EventCard key={event.id} event={event} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
