'use client'

import { useState } from 'react'
import { Terminal, FolderOpen, User, HeartPulse, Cog, Sparkles, ChevronDown, ChevronRight } from 'lucide-react'

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

export type LifecycleInfo = { label: string; color: string; pulse: boolean }

export function parseExitCode(outputSummary: string | null): number | null {
  if (!outputSummary) return null
  const match = outputSummary.match(/^exit (\d+)/)
  return match ? parseInt(match[1], 10) : null
}

export function getLifecycleInfo(event: AgentEvent): LifecycleInfo | null {
  if (event.tool === 'shell') {
    if (event.type === 'command_start') return { label: 'Running', color: 'text-yellow-400', pulse: true }
    if (event.type === 'command_complete') {
      return event.success === false
        ? { label: 'Failed', color: 'text-red-400', pulse: false }
        : { label: 'Completed', color: 'text-brand-400', pulse: false }
    }
  }
  if (event.tool === 'runtime') {
    if (event.type === 'work_received') return { label: 'Received', color: 'text-yellow-400', pulse: true }
    if (event.type === 'work_completed') return { label: 'Completed', color: 'text-brand-400', pulse: false }
    if (event.type === 'work_failed') return { label: 'Failed', color: 'text-red-400', pulse: false }
  }
  return null
}

const TOOL_ICONS: Record<string, typeof Terminal> = {
  shell: Terminal,
  filesystem: FolderOpen,
  runtime: Cog,
  identity: User,
  health: HeartPulse,
  inference: Sparkles,
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
        {(() => {
          const lifecycle = getLifecycleInfo(event)
          if (lifecycle) {
            const exitCode = event.type === 'command_complete' ? parseExitCode(event.output_summary) : null
            return (
              <>
                <span className={`text-xs flex items-center gap-1 ${lifecycle.color}`}>
                  {lifecycle.pulse && (
                    <span className="h-1.5 w-1.5 rounded-full bg-yellow-400 animate-pulse" />
                  )}
                  {lifecycle.label}
                </span>
                {exitCode !== null && (
                  <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                    exitCode === 0
                      ? 'text-brand-400 bg-brand-900/30'
                      : 'text-red-400 bg-red-900/30'
                  }`}>
                    exit {exitCode}
                  </span>
                )}
              </>
            )
          }
          return (
            <>
              {event.success === true && <span className="text-brand-400 text-xs">OK</span>}
              {event.success === false && <span className="text-red-400 text-xs">FAIL</span>}
            </>
          )
        })()}
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

      {expanded && event.tool === 'inference' && event.metadata && (
        <div className="mt-2 pl-6 text-xs grid grid-cols-2 gap-x-6 gap-y-1" data-testid="event-details">
          <div><span className="text-mountain-400">Model:</span> <span className="text-mountain-300">{String(event.metadata.model_name)}</span></div>
          <div><span className="text-mountain-400">Type:</span> <span className="text-mountain-300">{String(event.metadata.request_type)}</span></div>
          <div><span className="text-mountain-400">Input:</span> <span className="text-mountain-300">{Number(event.metadata.input_tokens).toLocaleString()} tokens</span></div>
          <div><span className="text-mountain-400">Output:</span> <span className="text-mountain-300">{Number(event.metadata.output_tokens).toLocaleString()} tokens</span></div>
          <div><span className="text-mountain-400">Cost:</span> <span className="text-mountain-300">${Number(event.metadata.cost_usd).toFixed(4)}</span></div>
          <div>
            <span className="text-mountain-400">Status:</span>{' '}
            <span className={event.metadata.status === 'success' ? 'text-brand-400' : 'text-red-400'}>
              {String(event.metadata.status)}
            </span>
          </div>
        </div>
      )}

      {expanded && event.tool !== 'inference' && (
        <div className="mt-2 pl-6 text-xs space-y-1" data-testid="event-details">
          <div><span className="text-mountain-400">Type:</span> <span className="text-mountain-300">{event.type}</span></div>
          {event.type === 'command_complete' && parseExitCode(event.output_summary) !== null && (
            <div>
              <span className="text-mountain-400">Exit Code:</span>{' '}
              <span className={parseExitCode(event.output_summary) === 0 ? 'text-brand-400' : 'text-red-400'}>
                {parseExitCode(event.output_summary)}
              </span>
            </div>
          )}
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
