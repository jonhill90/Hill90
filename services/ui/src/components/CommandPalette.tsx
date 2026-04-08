'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'
import { NAV_ITEMS, type NavLink, type NavItem } from '@/components/nav-items'

function flattenNavItems(items: NavItem[]): NavLink[] {
  const result: NavLink[] = []
  for (const item of items) {
    if (item.type === 'link') {
      result.push(item)
    } else {
      for (const child of item.children) {
        result.push(child)
      }
    }
  }
  return result
}

const ALL_LINKS = flattenNavItems(NAV_ITEMS)

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const router = useRouter()

  const filtered = useMemo(() => {
    if (!query.trim()) return ALL_LINKS
    const q = query.toLowerCase()
    return ALL_LINKS.filter(
      (link) =>
        link.label.toLowerCase().includes(q) ||
        link.href.toLowerCase().includes(q) ||
        link.id.toLowerCase().includes(q)
    )
  }, [query])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setSelectedIndex(0)
  }, [])

  const navigate = useCallback(
    (link: NavLink) => {
      close()
      if (link.external) {
        window.open(link.href, '_blank')
      } else {
        router.push(link.href)
      }
    },
    [close, router]
  )

  // Ctrl+K / Cmd+K to toggle
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [filtered])

  function handleKeyDown(e: React.KeyboardEvent) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex((prev) => (prev < filtered.length - 1 ? prev + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : filtered.length - 1))
        break
      case 'Enter':
        e.preventDefault()
        if (filtered[selectedIndex]) {
          navigate(filtered[selectedIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        close()
        break
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/60"
      onClick={close}
      data-testid="command-palette-overlay"
    >
      <div
        className="w-full max-w-lg bg-navy-800 border border-navy-700 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="command-palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-navy-700">
          <Search size={16} className="text-mountain-400 flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages..."
            className="flex-1 bg-transparent text-sm text-white placeholder-mountain-500 focus:outline-none"
            data-testid="command-palette-input"
          />
          <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono text-mountain-500 bg-navy-900 border border-navy-600 rounded">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-64 overflow-y-auto py-1" data-testid="command-palette-results">
          {filtered.length === 0 ? (
            <p className="px-4 py-6 text-sm text-mountain-500 text-center">No results</p>
          ) : (
            filtered.map((link, i) => {
              const Icon = link.icon
              return (
                <button
                  key={link.id}
                  onClick={() => navigate(link)}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                    i === selectedIndex
                      ? 'bg-brand-600/20 text-white'
                      : 'text-mountain-400 hover:bg-navy-700 hover:text-white'
                  }`}
                  data-testid="command-palette-item"
                >
                  <Icon size={16} className="flex-shrink-0" />
                  <span className="text-sm">{link.label}</span>
                  <span className="ml-auto text-xs text-mountain-500">{link.href}</span>
                </button>
              )
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-navy-700 text-[10px] text-mountain-500 flex items-center gap-3">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
