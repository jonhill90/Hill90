'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Circle,
  AlertCircle,
  CheckCircle2,
  Info,
  AlertTriangle,
  Clock,
} from 'lucide-react'

interface ActivityEvent {
  id: string
  timestamp: string
  type: string
  tool: string
  input_summary: string
  output_summary: string | null
  duration_ms: number | null
  success: boolean | null
  metadata?: Record<string, unknown>
}

type DotVariant = 'success' | 'error' | 'info' | 'warning'

function classifyEvent(event: ActivityEvent): DotVariant {
  if (event.success === false) return 'error'
  if (event.type === 'work_failed' || event.type === 'command_complete' && event.success === false) return 'error'
  if (event.type === 'work_received' || event.type === 'command_start') return 'warning'
  if (event.success === true || event.type === 'work_completed' || event.type === 'command_complete') return 'success'
  return 'info'
}

const DOT_STYLES: Record<DotVariant, { dot: string; icon: typeof Circle }> = {
  success: { dot: 'bg-brand-500', icon: CheckCircle2 },
  error: { dot: 'bg-red-500', icon: AlertCircle },
  info: { dot: 'bg-blue-500', icon: Info },
  warning: { dot: 'bg-yellow-500', icon: AlertTriangle },
}

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  if (diff < 0) return 'just now'
  if (diff < 1000) return 'just now'
  if (diff < 60_000) {
    const secs = Math.floor(diff / 1000)
    return `${secs} second${secs !== 1 ? 's' : ''} ago`
  }
  if (diff < 3_600_000) {
    const mins = Math.floor(diff / 60_000)
    return `${mins} minute${mins !== 1 ? 's' : ''} ago`
  }
  if (diff < 86_400_000) {
    const hrs = Math.floor(diff / 3_600_000)
    return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`
  }
  const days = Math.floor(diff / 86_400_000)
  return `${days} day${days !== 1 ? 's' : ''} ago`
}

function eventLabel(event: ActivityEvent): string {
  const parts: string[] = []
  if (event.tool) parts.push(event.tool)
  if (event.type) parts.push(event.type.replace(/_/g, ' '))
  return parts.join(' \u00b7 ')
}

function eventDescription(event: ActivityEvent): string {
  if (event.input_summary) return event.input_summary
  if (event.output_summary) return event.output_summary
  return ''
}

const MAX_EVENTS = 200

export default function ActivityTimeline({
  agentId,
  agentStatus,
}: {
  agentId: string
  agentStatus: string
}) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [sseConnected, setSseConnected] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const handleScroll = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setAutoScroll(nearBottom)
  }, [])

  // Static fetch — always attempt on mount as baseline
  useEffect(() => {
    let cancelled = false

    async function fetchEvents() {
      try {
        const res = await fetch(`/api/agents/${agentId}/events?tail=50`)
        if (!res.ok) return
        const contentType = res.headers.get('content-type') || ''

        if (contentType.includes('application/json')) {
          const data = await res.json()
          if (!cancelled) {
            const arr = Array.isArray(data) ? data : data.events ?? []
            setEvents(arr.slice(-MAX_EVENTS))
          }
        }
      } catch {
        // SSE endpoint may not support static fetch — that's OK
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchEvents()
    return () => { cancelled = true }
  }, [agentId])

  // SSE streaming when agent is running
  useEffect(() => {
    if (agentStatus !== 'running') return

    const es = new EventSource(`/api/agents/${agentId}/events?follow=true&tail=50`)
    setSseConnected(true)

    es.onmessage = (msg) => {
      try {
        const event: ActivityEvent = JSON.parse(msg.data)
        setEvents((prev) => {
          // Dedupe by id
          if (prev.some((e) => e.id === event.id)) return prev
          const next = [...prev, event]
            .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
          return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
        })
        setLoading(false)
      } catch {
        // skip non-JSON lines
      }
    }

    es.addEventListener('end', () => { es.close(); setSseConnected(false) })
    es.addEventListener('error', () => { es.close(); setSseConnected(false) })

    return () => { es.close(); setSseConnected(false) }
  }, [agentId, agentStatus])

  // Auto-scroll
  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [events, autoScroll])

  if (loading) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-5">
        <div className="flex items-center gap-2">
          <div className="h-4 w-4 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
          <span className="text-sm text-mountain-400">Loading activity...</span>
        </div>
      </div>
    )
  }

  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-navy-700 bg-navy-800 p-8 text-center" data-testid="activity-empty">
        <Clock className="h-8 w-8 text-mountain-500 mx-auto mb-3" />
        <p className="text-sm text-mountain-400">No activity recorded yet.</p>
        <p className="text-xs text-mountain-500 mt-1">
          {agentStatus !== 'running'
            ? 'Start the agent to begin recording activity.'
            : 'Waiting for events...'}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-navy-700 bg-navy-800 p-5" data-testid="activity-timeline">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Activity Timeline</h2>
        {sseConnected && (
          <span className="flex items-center gap-1.5 text-xs text-brand-400">
            <span className="h-1.5 w-1.5 rounded-full bg-brand-400 animate-pulse" />
            Live
          </span>
        )}
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative max-h-[32rem] overflow-y-auto"
      >
        {/* Vertical line */}
        <div
          className="absolute left-3 top-0 bottom-0 w-px bg-navy-600"
          aria-hidden="true"
        />

        <div className="space-y-0">
          {events.map((event) => {
            const variant = classifyEvent(event)
            const style = DOT_STYLES[variant]
            const Icon = style.icon
            const desc = eventDescription(event)

            return (
              <div
                key={event.id}
                className="relative pl-9 py-2.5 group"
                data-testid="activity-event"
              >
                {/* Dot */}
                <div className="absolute left-1.5 top-3.5 z-10">
                  <Icon
                    className={`h-3.5 w-3.5 ${
                      variant === 'success' ? 'text-brand-400' :
                      variant === 'error' ? 'text-red-400' :
                      variant === 'warning' ? 'text-yellow-400' :
                      'text-blue-400'
                    }`}
                  />
                </div>

                <div className="rounded-md border border-navy-700 bg-navy-900/50 px-3 py-2 group-hover:border-navy-600 transition-colors">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-medium text-mountain-300">
                      {eventLabel(event)}
                    </span>
                    {event.duration_ms !== null && (
                      <span className="text-mountain-500">{event.duration_ms}ms</span>
                    )}
                    <span className="ml-auto text-mountain-500 whitespace-nowrap">
                      {relativeTime(event.timestamp)}
                    </span>
                  </div>
                  {desc && (
                    <p className="text-sm text-mountain-400 mt-1 truncate">
                      {desc}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  )
}
