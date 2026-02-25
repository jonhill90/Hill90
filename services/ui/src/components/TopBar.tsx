'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Menu } from 'lucide-react'
import HillLogo from '@/components/HillLogo'
import AuthButtons from '@/components/AuthButtons'
import MobileDrawer from '@/components/MobileDrawer'

interface TopBarProps {
  navExtra?: React.ReactNode
}

export default function TopBar({ navExtra }: TopBarProps) {
  const [mobileOpen, setMobileOpen] = useState(false)

  return (
    <>
      <header className="flex items-center justify-between px-4 py-3 border-b border-navy-700 bg-navy-900">
        {/* Left: hamburger + logo + breadcrumb */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="md:hidden text-mountain-400 hover:text-white transition-colors"
          >
            <Menu size={22} />
          </button>
          <Link href="/" aria-label="Go to homepage" className="logo-link inline-flex items-center">
            <HillLogo width={96} className="logo-glow-hold" />
          </Link>
          {navExtra && (
            <div className="hidden sm:flex items-center text-sm text-mountain-400">
              {navExtra}
            </div>
          )}
        </div>

        {/* Right: auth */}
        <AuthButtons />
      </header>

      <MobileDrawer open={mobileOpen} onClose={() => setMobileOpen(false)} />
    </>
  )
}
