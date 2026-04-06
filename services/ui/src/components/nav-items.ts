import { Home, LayoutDashboard, Bot, FileText, Book, ExternalLink, KeyRound, Cpu, BarChart3, BookOpen, Library, Wrench, Layers, Settings, Server, MessageSquare, Package, CheckSquare, Shield, HardDrive } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface NavLink {
  type: 'link'
  id: string
  label: string
  href: string
  icon: LucideIcon
  adminOnly?: boolean
  external?: boolean
}

export interface NavGroup {
  type: 'group'
  id: string
  label: string
  icon: LucideIcon
  children: NavLink[]
  adminOnly?: boolean
}

export type NavItem = NavLink | NavGroup

export const NAV_ITEMS: NavItem[] = [
  { type: 'link', id: 'home', label: 'Home', href: '/', icon: Home },
  { type: 'link', id: 'dashboard', label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { type: 'link', id: 'agents', label: 'Agents', href: '/agents', icon: Bot },
  { type: 'link', id: 'chat', label: 'Chat', href: '/chat', icon: MessageSquare },
  { type: 'link', id: 'tasks', label: 'Tasks', href: '/tasks', icon: CheckSquare },
  { type: 'link', id: 'knowledge', label: 'Knowledge', href: '/harness/knowledge', icon: BookOpen },
  {
    type: 'group',
    id: 'harness',
    label: 'Harness',
    icon: Layers,
    children: [
      { type: 'link', id: 'connections', label: 'Connections', href: '/harness/connections', icon: KeyRound },
      { type: 'link', id: 'models', label: 'Models', href: '/harness/models', icon: Cpu },
      { type: 'link', id: 'skills', label: 'Skills', href: '/harness/skills', icon: Wrench },
      { type: 'link', id: 'dependencies', label: 'Dependencies', href: '/harness/tools', icon: Package, adminOnly: true },
      { type: 'link', id: 'usage', label: 'Usage', href: '/harness/usage', icon: BarChart3 },
      { type: 'link', id: 'library', label: 'Library', href: '/harness/shared-knowledge', icon: Library },
      { type: 'link', id: 'storage', label: 'Storage', href: '/harness/storage', icon: HardDrive },
      { type: 'link', id: 'secrets', label: 'Secrets', href: '/harness/secrets', icon: Shield, adminOnly: true },
    ],
  },
  {
    type: 'group',
    id: 'docs',
    label: 'Docs',
    icon: Book,
    children: [
      { type: 'link', id: 'api-docs', label: 'API Docs', href: '/docs/api', icon: FileText, adminOnly: true },
      { type: 'link', id: 'platform-docs', label: 'Platform Docs', href: 'https://docs.hill90.com', icon: ExternalLink, external: true },
    ],
  },
  {
    type: 'group',
    id: 'admin',
    label: 'Admin',
    icon: Settings,
    adminOnly: true,
    children: [
      { type: 'link', id: 'admin-services', label: 'Services', href: '/admin/services', icon: Server },
    ],
  },
]
