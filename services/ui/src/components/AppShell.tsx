import TopBar from '@/components/TopBar'
import Sidebar from '@/components/Sidebar'

export default function AppShell({
  children,
  navExtra,
}: {
  children: React.ReactNode
  navExtra?: React.ReactNode
}) {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar: always visible, never scrolls away */}
      <TopBar navExtra={navExtra} />

      <div className="flex flex-1 min-h-0">
        {/* Sidebar: desktop only */}
        <Sidebar />

        {/* Main content */}
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <div className="flex-1 min-h-0 overflow-auto">
            {children}
          </div>

          <footer className="px-6 py-4 border-t border-navy-700 text-center text-xs text-mountain-500 flex-shrink-0">
            &copy; {new Date().getFullYear()} Hill90
          </footer>
        </div>
      </div>
    </div>
  )
}
