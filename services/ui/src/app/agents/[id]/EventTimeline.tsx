'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Terminal, FolderOpen, Cog, User, HeartPulse, Sparkles } from 'lucide-react'
import EventCard, { type AgentEvent, formatDuration } from './EventCard'

const MAX_EVENTS = 500
const MAX_STEP_GAP_MS = 3000
const TOOL_FILTERS = ['All', 'Shell', 'Filesystem', 'Runtime', 'Inference'] as const
type ToolFilter = typeof TOOL_FILTERS[number]

// ---------------------------------------------------------------------------
// Union-Find for O(n) grouping
// ---------------------------------------------------------------------------
class UnionFind {
  private parent: Map<number, number> = new Map()
  private rank: Map<number, number> = new Map()

  find(x: number): number {
    if (!this.parent.has(x)) {
      this.parent.set(x, x)
      this.rank.set(x, 0)
    }
    let root = x
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!
    }
    // Path compression
    let curr = x
    while (curr !== root) {
      const next = this.parent.get(curr)!
      this.parent.set(curr, root)
      curr = next
    }
    return root
  }

  union(x: number, y: number): void {
    const rx = this.find(x)
    const ry = this.find(y)
    if (rx === ry) return
    const rankX = this.rank.get(rx)!
    const rankY = this.rank.get(ry)!
    if (rankX < rankY) {
      this.parent.set(rx, ry)
    } else if (rankX > rankY) {
      this.parent.set(ry, rx)
    } else {
      this.parent.set(ry, rx)
      this.rank.set(rx, rankX + 1)
    }
  }
}

/**
 * Compute event groups using a three-phase algorithm.
 * Returns Map<eventId, groupId> — only events in groups of size >= 2 appear.
 */
export function computeGroups(events: AgentEvent[]): Map<string, string> {
  if (events.length < 2) return new Map()

  const uf = new UnionFind()

  // Phase 1 (Signal A): Index events by metadata.work_id
  const workIdIndex = new Map<string, number[]>()
  for (let i = 0; i < events.length; i++) {
    const wid = events[i].metadata?.work_id
    if (typeof wid === 'string') {
      const list = workIdIndex.get(wid)
      if (list) {
        list.push(i)
      } else {
        workIdIndex.set(wid, [i])
      }
    }
  }
  for (const indices of workIdIndex.values()) {
    if (indices.length >= 2) {
      for (let k = 1; k < indices.length; k++) {
        uf.union(indices[0], indices[k])
      }
    }
  }

  // Phase 1b (Signal C): Index events by metadata.command_id
  const commandIdIndex = new Map<string, number[]>()
  for (let i = 0; i < events.length; i++) {
    const cid = events[i].metadata?.command_id
    if (typeof cid === 'string') {
      const list = commandIdIndex.get(cid)
      if (list) { list.push(i) } else { commandIdIndex.set(cid, [i]) }
    }
  }
  for (const indices of commandIdIndex.values()) {
    if (indices.length >= 2) {
      for (let k = 1; k < indices.length; k++) {
        uf.union(indices[0], indices[k])
      }
    }
  }

  // Phase 2 (Signal B): Adjacent inference→runtime scan
  const SIGNAL_B_TYPES = new Set(['work_received', 'work_completed'])
  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i]
    const b = events[i + 1]
    if (
      a.tool === 'inference' &&
      b.tool === 'runtime' &&
      SIGNAL_B_TYPES.has(b.type) &&
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() <= MAX_STEP_GAP_MS
    ) {
      uf.union(i, i + 1)
    }
  }

  // Phase 3: Collect components, discard size 1
  const components = new Map<number, number[]>()
  for (let i = 0; i < events.length; i++) {
    const root = uf.find(i)
    const list = components.get(root)
    if (list) {
      list.push(i)
    } else {
      components.set(root, [i])
    }
  }

  const result = new Map<string, string>()
  for (const [root, indices] of components) {
    if (indices.length < 2) continue
    const groupId = `group-${root}`
    for (const idx of indices) {
      result.set(events[idx].id, groupId)
    }
  }

  return result
}

type Segment = { groupId: string | null; events: AgentEvent[] }

function buildSegments(events: AgentEvent[], groups: Map<string, string>): Segment[] {
  const segments: Segment[] = []
  for (const event of events) {
    const gid = groups.get(event.id) ?? null
    const last = segments[segments.length - 1]
    if (last && last.groupId === gid && gid !== null) {
      last.events.push(event)
    } else {
      segments.push({ groupId: gid, events: [event] })
    }
  }
  return segments
}

// ---------------------------------------------------------------------------
// Group status derivation — scoped to runtime work-step events only
// ---------------------------------------------------------------------------
export type GroupStatus = 'completed' | 'failed' | 'in_progress'

const WORK_STEP_TYPES = new Set(['work_received', 'work_completed', 'work_failed'])

export function deriveGroupStatus(groupEvents: AgentEvent[]): GroupStatus | null {
  let hasWorkReceived = false
  let hasWorkCompleted = false
  let hasWorkFailed = false

  for (const event of groupEvents) {
    if (event.tool !== 'runtime' || !WORK_STEP_TYPES.has(event.type)) continue
    if (event.type === 'work_received') hasWorkReceived = true
    else if (event.type === 'work_completed') hasWorkCompleted = true
    else if (event.type === 'work_failed') hasWorkFailed = true
  }

  if (!hasWorkReceived && !hasWorkCompleted && !hasWorkFailed) return null

  if (hasWorkFailed) return 'failed'
  if (hasWorkCompleted) return 'completed'
  return 'in_progress'
}

export function computeGroupSpan(groupEvents: AgentEvent[]): number | null {
  if (groupEvents.length < 2) return null
  let minTs = Infinity
  let maxTs = -Infinity
  for (const event of groupEvents) {
    const t = new Date(event.timestamp).getTime()
    if (t < minTs) minTs = t
    if (t > maxTs) maxTs = t
  }
  return Math.max(0, maxTs - minTs)
}

// Local icon map — duplicated from EventCard to avoid coupling
const BANNER_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  filesystem: FolderOpen,
  runtime: Cog,
  identity: User,
  health: HeartPulse,
  inference: Sparkles,
}

const GROUP_STATUS_CONFIG = {
  completed: { css: 'bg-brand-900/50 text-brand-400 border-brand-700', label: 'Completed' },
  failed: { css: 'bg-red-900/40 text-red-400 border-red-700', label: 'Failed' },
  in_progress: { css: 'bg-navy-700 text-mountain-400 border-navy-600', label: 'In Progress' },
} as const

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
      : filter === 'Runtime'
        ? events.filter((e) => e.tool !== 'inference')
        : events.filter((e) => e.tool === filter.toLowerCase())

  const groups = useMemo(() => computeGroups(filtered), [filtered])
  const segments = useMemo(() => buildSegments(filtered, groups), [filtered, groups])

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

      {events.length > 0 && (() => {
        const last = events[events.length - 1]
        const BannerIcon = BANNER_ICONS[last.tool] || Terminal
        const summary = last.input_summary.length > 60
          ? last.input_summary.slice(0, 57) + '...'
          : last.input_summary
        return (
          <div
            className="flex items-center gap-2 bg-navy-700/50 border border-navy-600 rounded-md px-3 py-2 mb-3"
            data-testid="latest-activity"
          >
            <BannerIcon className="h-4 w-4 text-mountain-400 shrink-0" />
            <span className="text-xs text-mountain-400">{last.tool}</span>
            <span className="text-sm text-mountain-300 truncate">{summary}</span>
          </div>
        )
      })()}

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="space-y-3 max-h-96 overflow-y-auto"
      >
        {filtered.length === 0 ? (
          <p className="text-sm text-mountain-500 py-4 text-center" data-testid="no-events">
            {events.length === 0 ? 'Waiting for events...' : 'No events match the current filter.'}
          </p>
        ) : (
          segments.map((seg) =>
            seg.groupId !== null ? (
              <div key={seg.groupId} className="relative pl-3">
                {(() => {
                  const status = deriveGroupStatus(seg.events)
                  if (status === null) return null
                  const cfg = GROUP_STATUS_CONFIG[status]
                  return (
                    <div
                      className={`inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-md border mb-1 ${cfg.css}`}
                      data-testid="group-status-badge"
                    >
                      {status === 'in_progress' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-mountain-400 animate-pulse" />
                      )}
                      {cfg.label}
                      {(() => {
                        const span = computeGroupSpan(seg.events)
                        if (span === null) return null
                        return <span> · {formatDuration(span)}</span>
                      })()}
                    </div>
                  )
                })()}
                <div
                  className="absolute left-0 top-3 bottom-3 w-0.5 bg-navy-600 rounded-full"
                  aria-hidden="true"
                  data-testid="group-spine"
                />
                <div className="space-y-0.5">
                  {seg.events.map((e) => (
                    <EventCard key={e.id} event={e} />
                  ))}
                </div>
              </div>
            ) : (
              <EventCard key={seg.events[0].id} event={seg.events[0]} />
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
