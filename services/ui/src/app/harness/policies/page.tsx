import { redirect } from 'next/navigation'
import { auth } from '@/auth'

export default async function PoliciesPage() {
  const session = await auth()

  if (!session) {
    redirect('/api/auth/signin')
  }

  // Deprecated user-facing surface: direct users to model management.
  redirect('/harness/models')
}
