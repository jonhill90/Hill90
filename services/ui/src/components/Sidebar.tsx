'use client'

import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useSession } from 'next-auth/react'
import { ChevronsLeft, ChevronsRight } from 'lucide-react'
import { NAV_ITEMS } from '@/components/nav-items'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem('sidebar-collapsed') === 'true'
  } catch {
    return false
  }
}

export default function Sidebar() {
  const pathname = usePathname()
  const { data: session } = useSession()
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const roles: string[] = (session?.user as any)?.roles ?? []
  const isAdmin = roles.includes('admin')

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || isAdmin)

  function toggleCollapse() {
    setCollapsed((prev) => {
      const next = !prev
      try {
        localStorage.setItem('sidebar-collapsed', String(next))
      } catch { /* SSR / privacy mode */ }
      return next
    })
  }

  return (
    <aside
      className={`hidden md:flex flex-col border-r border-navy-700 bg-navy-900 transition-[width] duration-200 ${
        collapsed ? 'w-[60px]' : 'w-[220px]'
      }`}
    >
      <nav className="flex-1 flex flex-col gap-1 px-2 py-4">
        {items.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-brand-500/15 text-brand-400'
                  : 'text-mountain-400 hover:bg-navy-800 hover:text-white'
              }`}
            >
              <Icon size={20} aria-hidden="true" />
              <span data-sidebar-label className={collapsed ? 'sr-only' : ''}>
                {item.label}
              </span>
            </Link>
          )
        })}
      </nav>

      <button
        onClick={toggleCollapse}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="flex items-center justify-center border-t border-navy-700 py-3 text-mountain-400 hover:text-white transition-colors"
      >
        {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
      </button>
    </aside>
  )
}
