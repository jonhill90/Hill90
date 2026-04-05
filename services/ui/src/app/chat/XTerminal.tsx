'use client'

import { useEffect, useRef, useCallback } from 'react'
import { useSession } from 'next-auth/react'

interface Props {
  threadId: string
}

export default function XTerminal({ threadId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<any>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<any>(null)
  const { data: session } = useSession()

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

    // Connect WebSocket directly to API service (Next.js doesn't proxy WS)
    const accessToken = (session as any).accessToken
    if (!accessToken) {
      term.write('\x1b[31m No access token — session may have expired. Try refreshing. \x1b[0m\r\n')
      return
    }
    const wsUrl = `wss://api.hill90.com/chat/threads/${threadId}/terminal?token=${encodeURIComponent(accessToken)}`

    const ws = new WebSocket(wsUrl)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => {
      term.write('\x1b[2m Connected to agent terminal \x1b[0m\r\n')
      // Send initial terminal size
      const dims = fitAddon.proposeDimensions()
      if (dims) {
        ws.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }))
      }
    }

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data))
      } else {
        term.write(event.data)
      }
    }

    ws.onclose = (event) => {
      term.write(`\r\n\x1b[2m Terminal disconnected (${event.code}) \x1b[0m\r\n`)
    }

    ws.onerror = () => {
      term.write('\r\n\x1b[31m Connection error \x1b[0m\r\n')
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
      resizeObserver.disconnect()
      ws.close()
      term.dispose()
    }
  }, [threadId, session])

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
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-[#9ece6a] animate-pulse" />
          <span className="text-xs text-[#565f89]">Observer</span>
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
