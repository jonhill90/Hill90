'use client'

import { useSession } from 'next-auth/react'
import Link from 'next/link'

export default function AdminDocsLink() {
  const { data: session } = useSession()

  if (!session?.user?.roles?.includes('admin')) {
    return null
  }

  return (
    <Link
      href="/docs/api"
      className="text-sm font-medium text-mountain-400 hover:text-white transition-colors"
    >
      API Docs
    </Link>
  )
}
