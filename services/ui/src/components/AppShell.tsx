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
    <div className="min-h-screen flex flex-col">
      {/* Top bar: logo, hamburger (mobile), auth */}
      <TopBar navExtra={navExtra} />

      <div className="flex flex-1">
        {/* Sidebar: desktop only */}
        <Sidebar />

        {/* Main content + footer */}
        <div className="flex flex-col flex-1 min-w-0">
          {children}

          <footer className="px-6 py-6 border-t border-navy-700 text-center text-sm text-mountain-500">
            &copy; {new Date().getFullYear()} Hill90
          </footer>
        </div>
      </div>
    </div>
  )
}
