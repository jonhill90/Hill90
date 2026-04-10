'use client'

import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { Terminal, Activity, Globe, MousePointerClick, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
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

interface ElementInfo {
  tag: string
  id: string | null
  classes: string[]
  text: string
  selector: string
  box: { x: number; y: number; w: number; h: number }
  outerHTML: string
}

function BrowserView({ threadId, active }: { threadId: string; active: boolean }) {
  const [screenshot, setScreenshot] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [urlInput, setUrlInput] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [takeControl, setTakeControl] = useState(false)
  const [describeMode, setDescribeMode] = useState(false)
  const [selectedElement, setSelectedElement] = useState<ElementInfo | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ x: number; y: number } | null>(null)
  const [description, setDescription] = useState('')
  const [sending, setSending] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const descInputRef = useRef<HTMLInputElement>(null)
  const urlInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch(`/api/chat/${threadId}/screenshot`)
        if (cancelled) return
        if (res.status === 404) { setError('Browser not active'); return }
        if (!res.ok) { setError(`Screenshot failed (${res.status})`); return }
        const data = await res.json()
        if (cancelled) return
        if (data.screenshot) {
          setScreenshot(data.screenshot)
          setUrl(data.url || null)
          if (!urlInputRef.current || document.activeElement !== urlInputRef.current) {
            setUrlInput(data.url || '')
          }
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

  const handleImageClick = useCallback(async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!takeControl || !imgRef.current) return
    const rect = imgRef.current.getBoundingClientRect()
    const xPct = Math.round(((e.clientX - rect.left) / rect.width) * 10000) / 100
    const yPct = Math.round(((e.clientY - rect.top) / rect.height) * 10000) / 100

    if (describeMode) {
      // Fetch element info at coordinates, then show floating popover
      try {
        const res = await fetch(`/api/chat/threads/${threadId}/browser-element`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x_percent: xPct, y_percent: yPct }),
        })
        const data = await res.json()
        if (data.success && data.element) {
          setSelectedElement(data.element)
          // Position popover below the click (in screen coords)
          setPopoverPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
          setDescription('')
          setTimeout(() => descInputRef.current?.focus(), 50)
        }
      } catch { /* ignore */ }
    } else {
      // Real click via browser tool
      try {
        await fetch(`/api/chat/threads/${threadId}/browser-click`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ x_percent: xPct, y_percent: yPct }),
        })
      } catch { /* ignore */ }
    }
  }, [takeControl, describeMode, threadId])

  const handleNavigate = useCallback(async () => {
    const target = urlInput.trim()
    if (!target) return
    const finalUrl = target.startsWith('http') ? target : `https://${target}`
    try {
      await fetch(`/api/chat/threads/${threadId}/browser-navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: finalUrl }),
      })
    } catch { /* ignore */ }
  }, [urlInput, threadId])

  const handleHistory = useCallback(async (action: 'back' | 'forward' | 'reload') => {
    try {
      await fetch(`/api/chat/threads/${threadId}/browser-history`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
    } catch { /* ignore */ }
  }, [threadId])

  const handleSendDescription = useCallback(async () => {
    if (!selectedElement || sending) return
    setSending(true)
    const el = selectedElement
    const desc = description.trim() || '(no description)'
    const msg = `[Selected ${el.tag}${el.id ? '#' + el.id : ''}${el.classes.length ? '.' + el.classes.slice(0,2).join('.') : ''} "${el.text.slice(0, 50)}"] ${desc}`
    try {
      await fetch(`/api/chat/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: msg }),
      })
    } catch { /* ignore */ }
    setSending(false)
    setSelectedElement(null)
    setPopoverPos(null)
    setDescription('')
  }, [selectedElement, description, threadId, sending])

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

  // Calculate selected element bounding box in image-relative percentages
  // selectedElement.box is in page coordinates; convert to image percent
  // Note: viewport is 1280x720 from agentbox
  const VIEWPORT_W = 1280
  const VIEWPORT_H = 720
  const elBox = selectedElement ? {
    left: (selectedElement.box.x / VIEWPORT_W) * 100,
    top: (selectedElement.box.y / VIEWPORT_H) * 100,
    width: (selectedElement.box.w / VIEWPORT_W) * 100,
    height: (selectedElement.box.h / VIEWPORT_H) * 100,
  } : null

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="browser-view">
      {/* Browser chrome: back/forward/reload + URL bar + Take Control/Describe */}
      <div className="px-2 py-1.5 border-b border-navy-700 bg-navy-800/50 flex items-center gap-1 min-h-0">
        <button
          onClick={() => handleHistory('back')}
          className="p-1 rounded text-mountain-400 hover:text-white hover:bg-navy-700 cursor-pointer"
          title="Back"
          data-testid="browser-back"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleHistory('forward')}
          className="p-1 rounded text-mountain-400 hover:text-white hover:bg-navy-700 cursor-pointer"
          title="Forward"
          data-testid="browser-forward"
        >
          <ArrowRight className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => handleHistory('reload')}
          className="p-1 rounded text-mountain-400 hover:text-white hover:bg-navy-700 cursor-pointer"
          title="Reload"
          data-testid="browser-reload"
        >
          <RotateCw className="w-3.5 h-3.5" />
        </button>
        <input
          ref={urlInputRef}
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleNavigate()}
          placeholder="Enter URL..."
          className="flex-1 rounded border border-navy-600 bg-navy-900 px-2 py-0.5 text-xs text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none min-w-0"
          data-testid="browser-url-input"
        />
        <div className="flex items-center gap-1 flex-shrink-0">
          {takeControl && (
            <button
              onClick={() => { setDescribeMode(!describeMode); setSelectedElement(null); setPopoverPos(null) }}
              className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${
                describeMode ? 'bg-brand-600 text-white' : 'text-mountain-400 hover:text-white hover:bg-navy-700 border border-navy-600'
              }`}
              data-testid="describe-mode-toggle"
              title="When on, clicking an element opens a chat popover instead of clicking the page"
            >
              {describeMode ? 'Describe: ON' : 'Describe'}
            </button>
          )}
          <button
            onClick={() => { setTakeControl(!takeControl); setDescribeMode(false); setSelectedElement(null); setPopoverPos(null) }}
            className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${
              takeControl ? 'bg-amber-600 text-white' : 'text-mountain-400 hover:text-white hover:bg-navy-700 border border-navy-600'
            }`}
            data-testid="take-control-toggle"
          >
            <MousePointerClick className="w-3 h-3" />
            {takeControl ? 'Take Control: ON' : 'Take Control'}
          </button>
        </div>
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
          {elBox && (
            <div
              className="absolute pointer-events-none border-2 border-brand-500 bg-brand-500/10 rounded-sm"
              style={{ left: `${elBox.left}%`, top: `${elBox.top}%`, width: `${elBox.width}%`, height: `${elBox.height}%` }}
              data-testid="element-highlight"
            />
          )}
          {selectedElement && popoverPos && (
            <div
              className="absolute z-20 w-72 rounded-lg border border-navy-600 bg-navy-800 shadow-xl p-2"
              style={{
                left: `${popoverPos.x}px`,
                top: `${popoverPos.y + 20}px`,
                transform: popoverPos.y > 200 ? 'translateY(-100%) translateY(-30px)' : 'none',
              }}
              data-testid="describe-popover"
            >
              <div className="text-xs text-mountain-400 mb-1 truncate">
                <span className="text-brand-400 font-mono">{selectedElement.tag}</span>
                {selectedElement.id && <span className="text-mountain-500">#{selectedElement.id}</span>}
                {selectedElement.classes.length > 0 && (
                  <span className="text-mountain-500">.{selectedElement.classes.slice(0, 2).join('.')}</span>
                )}
              </div>
              {selectedElement.text && (
                <div className="text-xs text-mountain-300 mb-2 italic truncate">"{selectedElement.text.slice(0, 60)}"</div>
              )}
              <input
                ref={descInputRef}
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSendDescription()
                  if (e.key === 'Escape') { setSelectedElement(null); setPopoverPos(null) }
                }}
                placeholder="What should change here?"
                className="w-full rounded border border-navy-600 bg-navy-900 px-2 py-1 text-xs text-white placeholder-mountain-500 focus:border-brand-500 focus:outline-none mb-2"
              />
              <div className="flex items-center gap-1">
                <button
                  onClick={handleSendDescription}
                  disabled={sending}
                  className="flex-1 px-2 py-1 text-xs font-medium rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-50 cursor-pointer"
                >
                  {sending ? 'Sending...' : 'Send'}
                </button>
                <button
                  onClick={() => { setSelectedElement(null); setPopoverPos(null) }}
                  className="px-2 py-1 text-xs text-mountain-400 hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
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
