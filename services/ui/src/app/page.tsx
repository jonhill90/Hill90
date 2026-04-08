'use client'

import { useSession } from 'next-auth/react'
import AppShell from '@/components/AppShell'
import LandingHero from '@/components/LandingHero'
import DashboardClient from './dashboard/DashboardClient'

export default function Home() {
  const { data: session, status } = useSession()

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-navy-900">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!session) {
    return <LandingHero />
  }

  return (
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-6xl mx-auto w-full">
        <DashboardClient session={session as any} />
      </main>
    </AppShell>
  )
}
