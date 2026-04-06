'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { useSession } from 'next-auth/react'
import { MousePointer } from 'lucide-react'

/** Fetch a fresh access token by hitting the session endpoint server-side. */
async function getFreshToken(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/session')
    if (!res.ok) return null
    const data = await res.json()
    return data?.accessToken || null
  } catch {
    return null
  }
}

interface Props {
  threadId: string
}

const PING_INTERVAL_MS = 30_000 // 30s client-side keep-alive

export default function XTerminal({ threadId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<any>(null)
  const dataListenerRef = useRef<any>(null)
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const reconnectRef = useRef(0)
  const maxReconnects = 5
  const { data: session } = useSession()
  const [controlling, setControlling] = useState(false)
  const [connected, setConnected] = useState(false)

  const connect = useCallback(async () => {
    if (!containerRef.current || !session) return

    // Dynamically import xterm (client-only, avoids SSR issues)
    const { Terminal } = await import('xterm')
    const { FitAddon } = await import('@xterm/addon-fit')
    const { WebLinksAddon } = await import('@xterm/addon-web-links')

    const term = new Terminal({
      cursorBlink: true,
      disableStdin: true,
      fontSize: 14,
      fontFamily: "'FiraCode Nerd Font', 'Fira Code', 'JetBrains Mono', monospace",
      theme: {
        // Tokyo Night color scheme
        background: '#1a1b26',
        foreground: '#a9b1d6',
        cursor: '#c0caf5',
        selectionBackground: '#33467c',
        black: '#15161e',
        red: '#f7768e',
        green: '#9ece6a',
        yellow: '#e0af68',
        blue: '#7aa2f7',
        magenta: '#bb9af7',
        cyan: '#7dcfff',
        white: '#a9b1d6',
        brightBlack: '#414868',
        brightRed: '#f7768e',
        brightGreen: '#9ece6a',
        brightYellow: '#e0af68',
        brightBlue: '#7aa2f7',
        brightMagenta: '#bb9af7',
        brightCyan: '#7dcfff',
        brightWhite: '#c0caf5',
      },
      scrollback: 5000,
      convertEol: true,
    })

    const fitAddon = new FitAddon()
    const webLinksAddon = new WebLinksAddon()

    term.loadAddon(fitAddon)
    term.loadAddon(webLinksAddon)

    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitRef.current = fitAddon

    // Connect WebSocket — fetch fresh token from server to avoid expiry
    const accessToken = await getFreshToken() || (session as any).accessToken
    if (!accessToken) {
      term.write('\x1b[31m No access token — session may have expired. Try refreshing. \x1b[0m\r\n')
      return
    }
    const wsUrl = `wss://api.hill90.com/chat/threads/${threadId}/terminal?token=${encodeURIComponent(accessToken)}`

    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      reconnectRef.current = 0
      setConnected(true)
      const dims = fitAddon.proposeDimensions()
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
      // Start keep-alive ping to prevent idle disconnects from
      // Traefik, reverse proxies, and browser network stacks
      if (pingRef.current) clearInterval(pingRef.current)
      pingRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, PING_INTERVAL_MS)
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
      } else {
        term.write(event.data)
      }
    }

    ws.onclose = (event) => {
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
      setConnected(false)
      setControlling(false)

      // Don't reconnect on auth rejection or intentional close
      if (event.code === 4001 || event.code === 1000) return

      // Auto-reconnect with server-refreshed token
      if (reconnectRef.current < maxReconnects) {
        reconnectRef.current++
        const delay = Math.min(2000 * reconnectRef.current, 10000)
        setTimeout(async () => {
          const retryToken = await getFreshToken()
          if (!retryToken) return
          const retryUrl = `wss://api.hill90.com/chat/threads/${threadId}/terminal?token=${encodeURIComponent(retryToken)}`
          const retryWs = new WebSocket(retryUrl)
          retryWs.binaryType = 'arraybuffer'
          wsRef.current = retryWs
          retryWs.onopen = ws.onopen
          retryWs.onmessage = ws.onmessage
          retryWs.onclose = ws.onclose
          retryWs.onerror = ws.onerror
        }, delay)
      }
    }

    ws.onerror = () => {
      // Error logged, onclose handles reconnect
    }

    // Handle resize
    const handleResize = () => {
      fitAddon.fit()
      const dims = fitAddon.proposeDimensions()
      if (dims && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    const resizeObserver = new ResizeObserver(handleResize)
    resizeObserver.observe(containerRef.current)

    return () => {
      if (pingRef.current) {
        clearInterval(pingRef.current)
        pingRef.current = null
      }
      resizeObserver.disconnect()
      ws.close()
      term.dispose()
    }
  }, [threadId, session])

  // Toggle control mode — enable/disable stdin and attach/detach data listener
  const toggleControl = useCallback(() => {
    const term = termRef.current
    const ws = wsRef.current
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return

    if (controlling) {
      // Release control
      term.options.disableStdin = true
      if (dataListenerRef.current) {
        dataListenerRef.current.dispose()
        dataListenerRef.current = null
      }
      setControlling(false)
    } else {
      // Take control — enable stdin, relay keystrokes to agentbox PTY
      term.options.disableStdin = false
      term.focus()
      dataListenerRef.current = term.onData((data: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          // Send as binary (raw terminal input)
          ws.send(new TextEncoder().encode(data))
        }
      })
      setControlling(true)
    }
  }, [controlling])

  useEffect(() => {
    let cleanup: (() => void) | undefined

    connect().then((fn) => {
      cleanup = fn
    })

    return () => {
      cleanup?.()
    }
  }, [connect])

  return (
    <div className="flex flex-col h-full" data-testid="terminal-pane">
      <div className="px-3 py-2 border-b border-[#292e42] bg-[#1a1b26] flex items-center justify-between">
        <h3 className="text-sm font-semibold text-[#a9b1d6]">Terminal</h3>
        <div className="flex items-center gap-3">
          {connected && (
            <button
              onClick={toggleControl}
              className={`flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md transition-all ${
                controlling
                  ? 'bg-[#f7768e]/20 text-[#f7768e] border border-[#f7768e]/30 hover:bg-[#f7768e]/30'
                  : 'bg-[#7aa2f7]/10 text-[#7aa2f7] border border-[#7aa2f7]/20 hover:bg-[#7aa2f7]/20'
              }`}
              data-testid="control-toggle"
            >
              {controlling ? (
                <>
                  <MousePointer className="w-3 h-3" />
                  Release
                </>
              ) : (
                <>
                  <MousePointer className="w-3 h-3" />
                  Take Control
                </>
              )}
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${connected ? 'bg-[#9ece6a] animate-pulse' : 'bg-[#414868]'}`} />
            <span className="text-xs text-[#565f89]">
              {controlling ? 'Controlling' : connected ? 'Observing' : 'Disconnected'}
            </span>
          </div>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-[#1a1b26] overflow-hidden"
        style={{ padding: '4px' }}
      />
    </div>
  )
}
