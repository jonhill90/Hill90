'use client'

import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { Terminal, Activity, Globe, MousePointerClick } from 'lucide-react'
import EventCard, { type AgentEvent } from '@/app/agents/[id]/EventCard'

const XTerminal = lazy(() => import('./XTerminal'))

const MAX_EVENTS = 200
const MAX_TERMINAL_LINES = 500
const TOOL_FILTERS = ['All', 'Shell', 'Runtime', 'Inference'] as const
type ToolFilter = typeof TOOL_FILTERS[number]
type ViewMode = 'events' | 'terminal' | 'browser'

interface Props {
  threadId: string
  initialTab?: ViewMode
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

const SCREENSHOT_POLL_MS = 2000

function BrowserView({ threadId, active }: { threadId: string; active: boolean }) {
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [takeControl, setTakeControl] = useState(false)
  const [clickPoint, setClickPoint] = useState<{ x: number; y: number } | null>(null)
  const [describing, setDescribing] = useState(false)
  const [description, setDescription] = useState('')
  const [sending, setSending] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const descInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!active) return

    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(`/api/chat/${threadId}/screenshot`)
        if (cancelled) return
        if (res.status === 404) {
          setError('Browser not active')
          return
        }
        if (!res.ok) {
          setError(`Screenshot failed (${res.status})`)
          return
        }
        const data = await res.json()
        if (cancelled) return
        if (data.screenshot) {
          setScreenshot(data.screenshot)
          setUrl(data.url || null)
          setError(null)
        } else {
          setError(data.error || 'No screenshot available')
        }
      } catch {
        if (!cancelled) setError('Failed to fetch screenshot')
      }
    }

    poll()
    const interval = setInterval(poll, SCREENSHOT_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [threadId, active])

  const handleImageClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeControl || !imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 10000) / 100
    const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 10000) / 100
    setClickPoint({ x: xPct, y: yPct })
    setDescribing(true)
    setDescription('')
    setTimeout(() => descInputRef.current?.focus(), 50)
  }, [takeControl])

  const handleSendClick = useCallback(async () => {
    if (!clickPoint || sending) return
    setSending(true)
    const msg = description.trim()
      ? `[Click at ${clickPoint.x}%, ${clickPoint.y}%] ${description.trim()}`
      : `Click at position ${clickPoint.x}%, ${clickPoint.y}% on the page`
    try {
      await fetch(`/api/chat/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg }),
      })
    } catch { /* ignore */ }
    setSending(false)
    setDescribing(false)
    setDescription('')
    // Keep clickPoint visible briefly then clear
    setTimeout(() => setClickPoint(null), 1500)
  }, [clickPoint, description, threadId, sending])

  if (error && !screenshot) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-6" data-testid="browser-inactive">
        <Globe className="w-10 h-10 text-mountain-500" />
        <p className="text-sm text-mountain-500 text-center">{error}</p>
        <p className="text-xs text-mountain-600 text-center max-w-xs">
          When the agent uses the Playwright browser tool, screenshots will appear here in real time.
        </p>
      </div>
    )
  }

  if (!screenshot) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="browser-view">
      <div className="px-3 py-1.5 border-b border-navy-700 bg-navy-800/50 flex items-center gap-2 min-h-0">
        {url && (
          <>
            <Globe className="w-3 h-3 text-mountain-400 flex-shrink-0" />
            <span className="text-xs text-mountain-400 truncate flex-1">{url}</span>
          </>
        )}
        <button
          onClick={() => { setTakeControl(!takeControl); setDescribing(false); setClickPoint(null) }}
          className={`ml-auto flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${
            takeControl
              ? 'bg-amber-600 text-white'
              : 'text-mountain-400 hover:text-white hover:bg-navy-700 border border-navy-600'
          }`}
          data-testid="take-control-toggle"
        >
          <MousePointerClick className="w-3 h-3" />
          {takeControl ? 'Take Control: ON' : 'Take Control'}
        </button>
      </div>
      <div className="flex-1 overflow-auto p-2 flex items-start justify-center bg-navy-900/50">
        <div className="relative inline-block">
          <img
            ref={imgRef}
            src={`data:image/png;base64,${screenshot}`}
            alt="Browser screenshot"
            className={`max-w-full h-auto rounded border border-navy-700 ${takeControl ? 'cursor-crosshair' : ''}`}
            onClick={handleImageClick}
            data-testid="browser-screenshot"
          />
          {clickPoint && (
            <div
              className="absolute w-4 h-4 -ml-2 -mt-2 pointer-events-none"
              style={{ left: `${clickPoint.x}%`, top: `${clickPoint.y}%` }}
              data-testid="click-dot"
            >
              <span className="absolute inset-0 rounded-full bg-amber-400 animate-ping opacity-75" />
              <span className="absolute inset-0.5 rounded-full bg-amber-400" />
            </div>
          )}
        </div>
      </div>
      {describing && (
        <div className="px-3 py-2 border-t border-navy-700 bg-navy-800 flex items-center gap-2" data-testid="click-describe-bar">
          <span className="text-xs text-mountain-400 flex-shrink-0">
            Clicked {clickPoint?.x}%, {clickPoint?.y}%
          </span>
          <input
            ref={descInputRef}
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSendClick()}
            placeholder="Describe what to do here (optional)..."
            className="flex-1 rounded-md border border-navy-600 bg-navy-900 px-2 py-1 text-xs text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none"
          />
          <button
            onClick={handleSendClick}
            disabled={sending}
            className="px-3 py-1 text-xs font-medium rounded bg-brand-600 hover:bg-brand-500 text-white transition-colors disabled:opacity-50 cursor-pointer"
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
          <button
            onClick={() => { setDescribing(false); setClickPoint(null) }}
            className="px-2 py-1 text-xs text-mountain-400 hover:text-white transition-colors cursor-pointer"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

export default function SessionPane({ threadId, initialTab }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>(initialTab || 'terminal')

  useEffect(() => {
    if (initialTab) setViewMode(initialTab)
  }, [initialTab])

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
        <BrowserView threadId={threadId} active={viewMode === 'browser'} />
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
