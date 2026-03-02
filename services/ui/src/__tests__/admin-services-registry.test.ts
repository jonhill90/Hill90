import { describe, it, expect } from 'vitest'

import { ADMIN_SERVICES } from '@/utils/admin-services'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin services registry', () => {
  it('exports ADMIN_SERVICES as an array', () => {
    expect(Array.isArray(ADMIN_SERVICES)).toBe(true)
  })

  it('contains exactly 7 services', () => {
    expect(ADMIN_SERVICES).toHaveLength(7)
  })

  it('contains expected service IDs', () => {
    const ids = ADMIN_SERVICES.map((s: any) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'keycloak',
        'openbao',
        'grafana',
        'portainer',
        'minio',
        'traefik',
        'litellm',
      ])
    )
    expect(ids).toHaveLength(7)
  })

  it('each service has required fields with correct types', () => {
    for (const service of ADMIN_SERVICES) {
      const s = service as any
      expect(typeof s.id).toBe('string')
      expect(typeof s.name).toBe('string')
      expect(typeof s.purpose).toBe('string')
      expect(typeof s.url).toBe('string')
      expect(typeof s.authMethod).toBe('string')
      expect(typeof s.network).toBe('string')
      expect(typeof s.ssoStatus).toBe('string')
    }
  })

  it('all URLs start with https://', () => {
    for (const service of ADMIN_SERVICES) {
      const s = service as any
      expect(s.url).toMatch(/^https:\/\//)
    }
  })
})
