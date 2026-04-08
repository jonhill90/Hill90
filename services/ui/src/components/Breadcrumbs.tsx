'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

const SEGMENT_LABELS: Record<string, string> = {
  agents: 'Agents',
  chat: 'Chat',
  tasks: 'Tasks',
  dashboard: 'Dashboard',
  settings: 'Settings',
  harness: 'Harness',
  connections: 'Connections',
  models: 'Models',
  skills: 'Skills',
  tools: 'Dependencies',
  usage: 'Usage',
  knowledge: 'Knowledge',
  'shared-knowledge': 'Library',
  storage: 'Storage',
  monitoring: 'Monitoring',
  workflows: 'Workflows',
  secrets: 'Secrets',
  admin: 'Admin',
  services: 'Services',
  docs: 'Docs',
  api: 'API Docs',
  new: 'New',
  edit: 'Edit',
  profile: 'Profile',
}

function labelFor(segment: string): string {
  return SEGMENT_LABELS[segment] || segment
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

export default function Breadcrumbs() {
  const pathname = usePathname()

  if (!pathname || pathname === '/') return null

  const segments = pathname.split('/').filter(Boolean)
  if (segments.length <= 1) return null

  const crumbs: { label: string; href: string }[] = []

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const href = '/' + segments.slice(0, i + 1).join('/')

    if (isUuid(seg)) {
      crumbs.push({ label: 'Detail', href })
    } else {
      crumbs.push({ label: labelFor(seg), href })
    }
  }

  return (
    <nav aria-label="Breadcrumb" className="px-6 pt-4 pb-0">
      <ol className="flex items-center gap-1 text-xs text-mountain-500">
        <li>
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
        </li>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1
          return (
            <li key={crumb.href} className="flex items-center gap-1">
              <ChevronRight size={12} className="text-mountain-600" />
              {isLast ? (
                <span className="text-mountain-300">{crumb.label}</span>
              ) : (
                <Link href={crumb.href} className="hover:text-white transition-colors">
                  {crumb.label}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
