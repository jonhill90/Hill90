'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ['?'], description: 'Open this help' },
  { keys: ['Esc'], description: 'Close modal / cancel' },
  { keys: ['G', 'A'], description: 'Go to Agents' },
  { keys: ['G', 'C'], description: 'Go to Chat' },
  { keys: ['G', 'D'], description: 'Go to Dashboard' },
  { keys: ['G', 'T'], description: 'Go to Tasks' },
  { keys: ['G', 'H'], description: 'Go to Home' },
]

const GO_MAP: Record<string, string> = {
  a: '/agents',
  c: '/chat',
  d: '/dashboard',
  t: '/tasks',
  h: '/',
}

export default function KeyboardShortcuts() {
  const [open, setOpen] = useState(false)
  const [pendingG, setPendingG] = useState(false)
  const router = useRouter()

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return

    if (e.key === 'Escape') {
      setOpen(false)
      setPendingG(false)
      return
    }

    if (e.key === '?') {
      e.preventDefault()
      setOpen(prev => !prev)
      setPendingG(false)
      return
    }

    if (pendingG) {
      const dest = GO_MAP[e.key.toLowerCase()]
      if (dest) {
        e.preventDefault()
        router.push(dest)
        setOpen(false)
      }
      setPendingG(false)
      return
    }

    if (e.key === 'g' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      setPendingG(true)
      setTimeout(() => setPendingG(false), 1000)
    }
  }, [pendingG, router])

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return (
    <>
      {/* Floating ? button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 right-4 z-40 h-8 w-8 rounded-full border border-navy-600 bg-navy-800 text-mountain-400 hover:text-white hover:border-navy-500 transition-colors text-sm font-medium cursor-pointer flex items-center justify-center"
        aria-label="Keyboard shortcuts"
        data-testid="shortcuts-trigger"
      >
        ?
      </button>

      {/* G-pending indicator */}
      {pendingG && (
        <div className="fixed bottom-14 right-4 z-40 px-2 py-1 rounded-md bg-navy-800 border border-navy-600 text-xs text-mountain-400">
          g &rarr; …
        </div>
      )}

      {/* Modal */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setOpen(false)}
          data-testid="shortcuts-modal"
        >
          <div
            className="rounded-lg border border-navy-700 bg-navy-800 p-6 w-full max-w-md shadow-xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-white">Keyboard Shortcuts</h2>
              <button
                onClick={() => setOpen(false)}
                className="text-mountain-400 hover:text-white transition-colors cursor-pointer text-sm"
              >
                Esc
              </button>
            </div>
            <div className="space-y-2">
              {SHORTCUTS.map(s => (
                <div key={s.description} className="flex items-center justify-between py-1.5">
                  <span className="text-sm text-mountain-300">{s.description}</span>
                  <div className="flex items-center gap-1">
                    {s.keys.map((k, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-mountain-500 text-xs mx-0.5">then</span>}
                        <kbd className="px-2 py-0.5 text-xs font-mono rounded border border-navy-600 bg-navy-900 text-mountain-300">
                          {k}
                        </kbd>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  )
}
