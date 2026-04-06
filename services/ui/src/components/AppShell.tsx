import TopBar from '@/components/TopBar'
import Sidebar from '@/components/Sidebar'

export default function AppShell({
  children,
  navExtra,
  noFooter,
}: {
  children: React.ReactNode
  navExtra?: React.ReactNode
  noFooter?: boolean
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <TopBar navExtra={navExtra} />

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar: desktop only */}
        <Sidebar />

        {/* Main content + footer */}
        <div className="flex flex-col flex-1 min-w-0">
          {children}

          {!noFooter && (
            <footer className="px-6 py-6 border-t border-navy-700 text-center text-sm text-mountain-500">
              &copy; {new Date().getFullYear()} Hill90
            </footer>
          )}
        </div>
      </div>
    </div>
  )
}
