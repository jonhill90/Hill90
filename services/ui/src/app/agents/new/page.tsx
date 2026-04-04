'use client'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AgentFormClient from './AgentFormClient'

export default function NewAgentPage() {
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
    <AppShell>
      <main className="flex-1 px-6 py-12 max-w-3xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-8">Create Agent</h1>
        <AgentFormClient isAdmin={(session?.user as any)?.roles?.includes('admin') ?? false} />
      </main>
    </AppShell>
  )
}
