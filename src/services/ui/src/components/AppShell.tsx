import Link from 'next/link'
import HillLogo from '@/components/HillLogo'
import AuthButtons from '@/components/AuthButtons'

export default function AppShell({
  children,
  navExtra,
}: {
  children: React.ReactNode
  navExtra?: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-navy-700">
        <Link href="/" aria-label="Go to homepage" className="logo-link inline-flex items-center">
          <HillLogo width={96} className="logo-glow-hold" />
        </Link>
        <div className="flex items-center gap-4">
          <Link
            href="/dashboard"
            className="text-sm font-medium text-mountain-400 hover:text-white transition-colors"
          >
            Dashboard
          </Link>
          <Link
            href="/agents"
            className="text-sm font-medium text-mountain-400 hover:text-white transition-colors"
          >
            Agents
          </Link>
          {navExtra}
          <AuthButtons />
        </div>
      </nav>

      {/* Content */}
      {children}

      {/* Footer */}
      <footer className="px-6 py-6 border-t border-navy-700 text-center text-sm text-mountain-500">
        &copy; {new Date().getFullYear()} Hill90
      </footer>
    </div>
  )
}
