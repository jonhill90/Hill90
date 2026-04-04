'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import ProfileClient from './ProfileClient'

export default function Profile() {
  const { data: session, status } = useSession()

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-navy-900">
        <div className="h-8 w-8 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell navExtra={<span className="text-sm font-medium text-white">Profile</span>}>
      <main className="flex-1 px-6 py-12 max-w-2xl mx-auto w-full">
        <ProfileClient session={session as any} />
      </main>
    </AppShell>
  )
}
