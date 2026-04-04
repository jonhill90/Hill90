'use client'

import React from 'react'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AgentEditClient from './AgentEditClient'

export default function EditAgentPage({ params }: { params: Promise<{ id: string }> }) {
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
      <main className="flex-1 px-6 py-12 max-w-3xl mx-auto w-full">
        <h1 className="text-2xl font-bold mb-8">Edit Agent</h1>
        <AgentEditClient agentId={id} isAdmin={(session?.user as any)?.roles?.includes('admin') ?? false} currentUserSub={(session?.user as any)?.id || (session?.user as any)?.sub || ''} />
      </main>
    </AppShell>
  )
}
