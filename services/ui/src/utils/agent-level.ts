/**
 * Agent level/progression system.
 *
 * XP is derived from total_inferences + chat_messages. Levels follow a
 * non-linear curve so early progression feels fast and later levels require
 * sustained usage.
 */

export interface LevelInfo {
  level: number
  title: string
  currentXp: number
  xpForCurrentLevel: number
  xpForNextLevel: number
  progress: number // 0-100
}

interface LevelThreshold {
  level: number
  xp: number
  title: string
}

const LEVEL_THRESHOLDS: readonly LevelThreshold[] = [
  { level: 1, xp: 0, title: 'Novice' },
  { level: 2, xp: 10, title: 'Novice' },
  { level: 3, xp: 50, title: 'Apprentice' },
  { level: 4, xp: 150, title: 'Apprentice' },
  { level: 5, xp: 400, title: 'Journeyman' },
  { level: 6, xp: 800, title: 'Journeyman' },
  { level: 7, xp: 1500, title: 'Expert' },
  { level: 8, xp: 3000, title: 'Expert' },
  { level: 9, xp: 6000, title: 'Master' },
  { level: 10, xp: 10000, title: 'Master' },
]

/**
 * Calculate XP from agent stats. Each inference counts as 1 XP,
 * each chat message counts as 0.5 XP.
 */
export function calculateXp(stats: { total_inferences?: number; chat_messages?: number } | null): number {
  if (!stats) return 0
  return Math.floor((stats.total_inferences || 0) + (stats.chat_messages || 0) * 0.5)
}

/**
 * Derive level info from raw XP value.
 */
export function getLevelInfo(xp: number): LevelInfo {
  let current = LEVEL_THRESHOLDS[0]

  for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_THRESHOLDS[i].xp) {
      current = LEVEL_THRESHOLDS[i]
      break
    }
  }

  const nextIndex = LEVEL_THRESHOLDS.findIndex((t) => t.level === current.level) + 1
  const next = nextIndex < LEVEL_THRESHOLDS.length ? LEVEL_THRESHOLDS[nextIndex] : null

  const xpIntoLevel = xp - current.xp
  const xpNeeded = next ? next.xp - current.xp : 1
  const progress = next ? Math.min(100, Math.floor((xpIntoLevel / xpNeeded) * 100)) : 100

  return {
    level: current.level,
    title: current.title,
    currentXp: xp,
    xpForCurrentLevel: current.xp,
    xpForNextLevel: next ? next.xp : current.xp,
    progress,
  }
}

/**
 * Convenience: stats object -> LevelInfo in one call.
 */
export function getAgentLevel(stats: { total_inferences?: number; chat_messages?: number } | null): LevelInfo {
  return getLevelInfo(calculateXp(stats))
}
