'use client'

import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { Terminal, Activity, Globe } from 'lucide-react'
import EventCard, { type AgentEvent } from '@/app/agents/[id]/EventCard'

const XTerminal = lazy(() => import('./XTerminal'))

const MAX_EVENTS = 200
const MAX_TERMINAL_LINES = 500
const TOOL_FILTERS = ['All', 'Shell', 'Runtime', 'Inference'] as const
type ToolFilter = typeof TOOL_FILTERS[number]
type ViewMode = 'events' | 'terminal' | 'browser'

interface Props {
  threadId: string
}

function TerminalBlock({ lines }: { lines: string[] }) {
  const termRef = useRef<HTMLPreElement>(null)
  const [collapsed, setCollapsed] = useState(lines.length > 50)

  useEffect(() => {
    if (!collapsed && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
    }
  }, [lines, collapsed])

  const displayLines = collapsed ? lines.slice(0, 5) : lines.slice(-MAX_TERMINAL_LINES)

  return (
    <div className="rounded border border-navy-700 bg-[#0d1117] overflow-hidden" data-testid="terminal-block">
      <pre
        ref={termRef}
        className="p-2 text-xs font-mono text-green-400 overflow-x-auto whitespace-pre-wrap leading-relaxed"
        style={{ maxHeight: collapsed ? '6rem' : '20rem', overflowY: 'auto' }}
      >
        {displayLines.join('\n')}
      </pre>
      {lines.length > 50 && (
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="w-full px-2 py-1 text-xs text-mountain-400 hover:text-white bg-navy-900/50 border-t border-navy-700 transition-colors"
        >
          {collapsed ? `Show all (${lines.length} lines)` : 'Collapse'}
        </button>
      )}
    </div>
  )
}

interface GroupedItem {
  type: 'event' | 'terminal'
  event?: AgentEvent
  commandId?: string
  lines?: string[]
}

function groupEventsWithTerminal(events: AgentEvent[]): GroupedItem[] {
  const items: GroupedItem[] = []
  const terminalBuffers = new Map<string, string[]>()

  for (const event of events) {
    const commandId = (event.metadata?.command_id as string) || ''

    if (event.type === 'command_output' && commandId) {
      if (!terminalBuffers.has(commandId)) {
        terminalBuffers.set(commandId, [])
      }
      terminalBuffers.get(commandId)!.push(event.output_summary || '')
      continue
    }

    // Flush terminal buffer before a command_complete for same command
    if (event.type === 'command_complete' && commandId && terminalBuffers.has(commandId)) {
      items.push({ type: 'terminal', commandId, lines: terminalBuffers.get(commandId)! })
      terminalBuffers.delete(commandId)
    }

    items.push({ type: 'event', event })
  }

  // Flush any remaining buffers (command still running)
  for (const [commandId, lines] of terminalBuffers) {
    items.push({ type: 'terminal', commandId, lines })
  }

  return items
}

function BrowserView({ events }: { events: AgentEvent[] }) {
  // Find the latest screenshot from browser_screenshot events
  const latestScreenshot = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (
        e.type === 'tool_result' &&
        e.tool === 'browser' &&
        e.metadata?.screenshot
      ) {
        return {
          url: e.metadata.url as string | undefined,
          screenshot: e.metadata.screenshot as string,
          timestamp: e.created_at,
        }
      }
    }
    return null
  }, [events])

  if (!latestScreenshot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6" data-testid="browser-inactive">
        <Globe className="w-10 h-10 text-mountain-500" />
        <p className="text-sm text-mountain-500 text-center">Browser not active</p>
        <p className="text-xs text-mountain-600 text-center max-w-xs">
          When the agent uses the Playwright browser tool, screenshots will appear here in real time.
        </p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="browser-view">
      {latestScreenshot.url && (
        <div className="px-3 py-1.5 border-b border-navy-700 bg-navy-800/50 flex items-center gap-2 min-h-0">
          <Globe className="w-3 h-3 text-mountain-400 flex-shrink-0" />
          <span className="text-xs text-mountain-400 truncate">{latestScreenshot.url}</span>
        </div>
      )}
      <div className="flex-1 overflow-auto p-2 flex items-start justify-center bg-navy-900/50">
        <img
          src={`data:image/png;base64,${latestScreenshot.screenshot}`}
          alt="Browser screenshot"
          className="max-w-full h-auto rounded border border-navy-700"
          data-testid="browser-screenshot"
        />
      </div>
    </div>
  )
}

export default function SessionPane({ threadId }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('terminal')
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
    const es = new EventSource(`/api/chat/threads/${threadId}/events?follow=true&tail=20`)

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

  const filtered = useMemo(() => {
    if (filter === 'All') return events
    const toolName = filter.toLowerCase()
    return events.filter(e => e.tool === toolName)
  }, [events, filter])

  const grouped = useMemo(() => groupEventsWithTerminal(filtered), [filtered])

  return (
    <div className="flex flex-col h-full" data-testid="session-pane">
      <div className="p-3 border-b border-navy-700 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode('terminal')}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
              viewMode === 'terminal'
                ? 'bg-brand-600 text-white'
                : 'text-mountain-400 hover:text-white hover:bg-navy-700'
            }`}
          >
            <Terminal className="w-3 h-3" />
            Terminal
          </button>
          <button
            onClick={() => setViewMode('events')}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
              viewMode === 'events'
                ? 'bg-brand-600 text-white'
                : 'text-mountain-400 hover:text-white hover:bg-navy-700'
            }`}
          >
            <Activity className="w-3 h-3" />
            Events
          </button>
          <button
            onClick={() => setViewMode('browser')}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
              viewMode === 'browser'
                ? 'bg-brand-600 text-white'
                : 'text-mountain-400 hover:text-white hover:bg-navy-700'
            }`}
            data-testid="browser-tab"
          >
            <Globe className="w-3 h-3" />
            Browser
          </button>
        </div>
        {viewMode === 'events' && (
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
        )}
      </div>

      {viewMode === 'terminal' ? (
        <Suspense fallback={
          <div className="flex-1 flex items-center justify-center bg-[#0d1117]">
            <p className="text-sm text-mountain-500">Loading terminal...</p>
          </div>
        }>
          <XTerminal threadId={threadId} />
        </Suspense>
      ) : viewMode === 'browser' ? (
        <BrowserView events={events} />
      ) : (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-3 space-y-2"
        >
          {grouped.length === 0 ? (
            <p className="text-sm text-mountain-500 text-center py-4" data-testid="no-events">
              {events.length === 0 ? 'Waiting for events...' : 'No events match filter.'}
            </p>
          ) : (
            grouped.map((item, i) => {
              if (item.type === 'terminal' && item.lines && item.lines.length > 0) {
                return <TerminalBlock key={`term-${item.commandId}-${i}`} lines={item.lines} />
              }
              if (item.type === 'event' && item.event) {
                return <EventCard key={item.event.id} event={item.event} />
              }
              return null
            })
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
