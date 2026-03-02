'use client'

import { useState } from 'react'
import { Terminal, FolderOpen, User, HeartPulse, ChevronDown, ChevronRight } from 'lucide-react'

export interface AgentEvent {
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

const TOOL_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  filesystem: FolderOpen,
  identity: User,
  health: HeartPulse,
}

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime()
  if (diff < 1000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

export default function EventCard({ event }: { event: AgentEvent }) {
  const [expanded, setExpanded] = useState(false)
  const Icon = TOOL_ICONS[event.tool] || Terminal

  const borderColor =
    event.success === true ? 'border-l-brand-500'
    : event.success === false ? 'border-l-red-500'
    : 'border-l-mountain-500'

  return (
    <div
      className={`rounded-md border border-navy-700 bg-navy-900 p-3 border-l-2 ${borderColor} cursor-pointer`}
      onClick={() => setExpanded(!expanded)}
      data-testid="event-card"
    >
      <div className="flex items-center gap-2 text-sm">
        <Icon className="h-4 w-4 text-mountain-400 shrink-0" />
        <span className="text-mountain-300 font-medium">{event.tool}</span>
        <span className="text-mountain-500 text-xs truncate flex-1">{event.input_summary}</span>
        {event.success === true && <span className="text-brand-400 text-xs">OK</span>}
        {event.success === false && <span className="text-red-400 text-xs">FAIL</span>}
        {event.duration_ms !== null && (
          <span className="text-mountain-500 text-xs">{event.duration_ms}ms</span>
        )}
        <span className="text-mountain-500 text-xs whitespace-nowrap">{relativeTime(event.timestamp)}</span>
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-mountain-500 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-mountain-500 shrink-0" />
        )}
      </div>

      {expanded && (
        <div className="mt-2 pl-6 text-xs space-y-1" data-testid="event-details">
          <div><span className="text-mountain-400">Type:</span> <span className="text-mountain-300">{event.type}</span></div>
          {event.output_summary && (
            <div><span className="text-mountain-400">Output:</span> <span className="text-mountain-300">{event.output_summary}</span></div>
          )}
          <div><span className="text-mountain-400">Time:</span> <span className="text-mountain-300">{new Date(event.timestamp).toISOString()}</span></div>
          {event.metadata && Object.keys(event.metadata).length > 0 && (
            <div>
              <span className="text-mountain-400">Metadata:</span>
              <pre className="text-mountain-300 mt-1 whitespace-pre-wrap">{JSON.stringify(event.metadata, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
