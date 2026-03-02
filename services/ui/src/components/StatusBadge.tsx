export default function StatusBadge({ status }: { status: string }) {
  if (status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-mountain-400">
        <span className="h-2 w-2 rounded-full bg-mountain-400 animate-pulse" />
        Checking
      </span>
    )
  }
  if (status === 'healthy') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-400">
        <span className="h-2 w-2 rounded-full bg-brand-500" />
        Healthy
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
      <span className="h-2 w-2 rounded-full bg-red-500" />
      Unhealthy
    </span>
  )
}
