'use client'

import React from 'react'

import { useSession } from 'next-auth/react'
import { redirect } from 'next/navigation'
import AppShell from '@/components/AppShell'
import ChatLayout from '../ChatLayout'

export default function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { data: session, status } = useSession()
  const resolvedParams = React.use(params)
  const threadId = resolvedParams.threadId

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
    <AppShell noFooter>
      <ChatLayout session={session as any} activeThreadId={threadId} />
    </AppShell>
  )
}
