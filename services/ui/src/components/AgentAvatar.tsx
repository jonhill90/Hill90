interface Props {
  name: string
  size?: 'sm' | 'md'
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

const SIZE_CLASSES = {
  sm: 'w-5 h-5 text-[9px]',
  md: 'w-7 h-7 text-[11px]',
}

export default function AgentAvatar({ name, size = 'md' }: Props) {
  const color = COLORS[hashName(name) % COLORS.length]

  return (
    <div
      className={`${SIZE_CLASSES[size]} rounded-full flex items-center justify-center flex-shrink-0 ${color} text-white font-semibold select-none`}
      title={name}
      data-testid="agent-avatar"
    >
      {initials(name)}
    </div>
  )
}
