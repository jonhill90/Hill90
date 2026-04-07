import { describe, it, expect } from 'vitest'
import { calculateXp, getLevelInfo, getAgentLevel } from '@/utils/agent-level'

describe('calculateXp', () => {
  it('returns 0 for null stats', () => {
    expect(calculateXp(null)).toBe(0)
  })

  it('counts inferences as 1 XP each', () => {
    expect(calculateXp({ total_inferences: 100, chat_messages: 0 })).toBe(100)
  })

  it('counts chat messages as 0.5 XP each', () => {
    expect(calculateXp({ total_inferences: 0, chat_messages: 100 })).toBe(50)
  })

  it('combines inferences and messages', () => {
    expect(calculateXp({ total_inferences: 100, chat_messages: 100 })).toBe(150)
  })

  it('handles undefined fields', () => {
    expect(calculateXp({})).toBe(0)
  })
})

describe('getLevelInfo', () => {
  it('returns level 1 for 0 XP', () => {
    const info = getLevelInfo(0)
    expect(info.level).toBe(1)
    expect(info.title).toBe('Novice')
    expect(info.progress).toBe(0)
  })

  it('returns level 2 at 10 XP', () => {
    const info = getLevelInfo(10)
    expect(info.level).toBe(2)
    expect(info.title).toBe('Novice')
  })

  it('returns level 5 Journeyman at 400 XP', () => {
    const info = getLevelInfo(400)
    expect(info.level).toBe(5)
    expect(info.title).toBe('Journeyman')
  })

  it('returns level 10 Master at 10000 XP', () => {
    const info = getLevelInfo(10000)
    expect(info.level).toBe(10)
    expect(info.title).toBe('Master')
    expect(info.progress).toBe(100)
  })

  it('calculates progress correctly mid-level', () => {
    // Level 1 threshold: 0, Level 2 threshold: 10
    const info = getLevelInfo(5)
    expect(info.level).toBe(1)
    expect(info.progress).toBe(50)
  })

  it('provides xpForNextLevel', () => {
    const info = getLevelInfo(5)
    expect(info.xpForCurrentLevel).toBe(0)
    expect(info.xpForNextLevel).toBe(10)
  })
})

describe('getAgentLevel', () => {
  it('computes level from stats in one call', () => {
    const info = getAgentLevel({ total_inferences: 1234, chat_messages: 89 })
    // 1234 + 89*0.5 = 1278 XP -> Level 6 (800 threshold)
    expect(info.level).toBe(6)
    expect(info.title).toBe('Journeyman')
  })

  it('returns level 1 for null stats', () => {
    const info = getAgentLevel(null)
    expect(info.level).toBe(1)
    expect(info.title).toBe('Novice')
  })
})
