import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import ChatLayout from '../ChatLayout'

export default async function ThreadPage({ params }: { params: Promise<{ threadId: string }> }) {
  const session = await auth()
  if (!session) {
    redirect('/api/auth/signin')
  }

  const { threadId } = await params

  return (
    <AppShell>
      <ChatLayout session={session} activeThreadId={threadId} />
    </AppShell>
  )
}
