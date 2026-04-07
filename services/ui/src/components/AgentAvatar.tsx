interface Props {
  name: string
  avatarUrl?: string | null
  size?: 'sm' | 'md' | 'lg' | 'xl'
}

const COLORS = [
  'bg-blue-600',
  'bg-purple-600',
  'bg-amber-600',
  'bg-emerald-600',
  'bg-rose-600',
  'bg-cyan-600',
  'bg-orange-600',
  'bg-indigo-600',
  'bg-teal-600',
  'bg-pink-600',
]

function hashName(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0
  }
  return Math.abs(h)
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s\-_]+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

const SIZE_CLASSES: Record<string, string> = {
  sm: 'w-6 h-6 text-[9px]',
  md: 'w-8 h-8 text-[11px]',
  lg: 'w-12 h-12 text-base',
  xl: 'w-16 h-16 text-lg',
}

export default function AgentAvatar({ name, avatarUrl, size = 'md' }: Props) {
  const color = COLORS[hashName(name) % COLORS.length]
  const sizeClass = SIZE_CLASSES[size]

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        className={`${sizeClass} rounded-full object-cover flex-shrink-0`}
        title={name}
        data-testid="agent-avatar"
      />
    )
  }

  return (
    <div
      className={`${sizeClass} rounded-full flex items-center justify-center flex-shrink-0 ${color} text-white font-semibold select-none`}
      title={name}
      data-testid="agent-avatar"
    >
      {initials(name)}
    </div>
  )
}
