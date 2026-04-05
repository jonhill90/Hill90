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
      cursorBlink: false,
      disableStdin: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
      theme: {
        background: '#0f1720',
        foreground: '#e2e8f0',
        cursor: '#6db33a',
        selectionBackground: '#243044',
        black: '#0f1720',
        red: '#ff7b72',
        green: '#6db33a',
        yellow: '#d29922',
        blue: '#79c0ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#4a5568',
        brightRed: '#ffa198',
        brightGreen: '#5b9a2f',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
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
      <div className="p-3 border-b border-navy-700 bg-navy-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200">Terminal</h3>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-400 animate-pulse" />
          <span className="text-xs text-mountain-400">Observer</span>
        </div>
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 bg-navy-900"
        style={{ padding: '4px' }}
      />
    </div>
  )
}
