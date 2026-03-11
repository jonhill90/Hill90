import { redirect } from 'next/navigation'
import { auth } from '@/auth'
import AppShell from '@/components/AppShell'
import ChatLayout from './ChatLayout'

export default async function ChatPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  return (
    <AppShell>
      <ChatLayout session={session} />
    </AppShell>
  )
}
