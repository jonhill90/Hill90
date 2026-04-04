'use client'

import React from 'react'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AgentDetailClient from './AgentDetailClient'

export default function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { data: session, status } = useSession()
  const resolvedParams = React.use(params)
  const id = resolvedParams.id

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
      <main className="flex-1 px-6 py-12 max-w-4xl mx-auto w-full">
        <AgentDetailClient agentId={id} session={session as any} />
      </main>
    </AppShell>
  )
}
