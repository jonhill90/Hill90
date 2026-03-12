'use client'

import { useState } from 'react'
import { Square } from 'lucide-react'

interface Props {
  threadId: string
  hasPending: boolean
  onCancelled?: () => void
}

export default function CancelButton({ threadId, hasPending, onCancelled }: Props) {
  const [cancelling, setCancelling] = useState(false)

  if (!hasPending) return null

  const handleCancel = async () => {
    setCancelling(true)
    try {
      const res = await fetch(`/api/chat/${threadId}/cancel`, { method: 'POST' })
      if (res.ok) {
        onCancelled?.()
      }
    } catch {
      // ignore
    } finally {
      setCancelling(false)
    }
  }

  return (
    <button
      onClick={handleCancel}
      disabled={cancelling}
      className="flex items-center gap-1 px-2 py-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
      data-testid="cancel-button"
      title="Cancel pending responses"
    >
      <Square size={12} />
      {cancelling ? 'Cancelling...' : 'Cancel'}
    </button>
  )
}
