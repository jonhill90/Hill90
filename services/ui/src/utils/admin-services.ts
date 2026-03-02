export type AuthMethod = 'oidc' | 'basic-auth' | 'static-creds' | 'master-key' | 'native'
export type NetworkAccess = 'tailscale' | 'public'
export type SsoStatus = 'configured' | 'supported' | 'limited' | 'not-applicable'

export interface AdminService {
  id: string
  name: string
  purpose: string
  url: string
  authMethod: AuthMethod
  network: NetworkAccess
  ssoStatus: SsoStatus
  healthCheck?: {
    internalUrl: string
    path: string
  }
}

export const ADMIN_SERVICES: AdminService[] = [
  {
    id: 'keycloak',
    name: 'Keycloak',
    purpose: 'Identity provider and SSO',
    url: 'https://auth.hill90.com',
    authMethod: 'native',
    network: 'public',
    ssoStatus: 'not-applicable',
    healthCheck: {
      internalUrl: 'http://keycloak:8080',
      path: '/realms/hill90',
    },
  },
  {
    id: 'openbao',
    name: 'OpenBao',
    purpose: 'Secrets management and encryption',
    url: 'https://vault.hill90.com',
    authMethod: 'oidc',
    network: 'tailscale',
    ssoStatus: 'configured',
    healthCheck: {
      internalUrl: 'http://openbao:8200',
      path: '/v1/sys/health',
    },
  },
  {
    id: 'grafana',
    name: 'Grafana',
    purpose: 'Observability dashboards and alerting',
    url: 'https://grafana.hill90.com',
    authMethod: 'static-creds',
    network: 'tailscale',
    ssoStatus: 'supported',
    healthCheck: {
      internalUrl: 'http://grafana:3000',
      path: '/api/health',
    },
  },
  {
    id: 'portainer',
    name: 'Portainer',
    purpose: 'Container management dashboard',
    url: 'https://portainer.hill90.com',
    authMethod: 'basic-auth',
    network: 'tailscale',
    ssoStatus: 'supported',
    healthCheck: {
      internalUrl: 'http://portainer:9000',
      path: '/api/status',
    },
  },
  {
    id: 'minio',
    name: 'MinIO',
    purpose: 'Object storage (S3-compatible)',
    url: 'https://storage.hill90.com',
    authMethod: 'static-creds',
    network: 'tailscale',
    ssoStatus: 'supported',
    healthCheck: {
      internalUrl: 'http://minio:9000',
      path: '/minio/health/live',
    },
  },
  {
    id: 'traefik',
    name: 'Traefik',
    purpose: 'Edge proxy and TLS termination',
    url: 'https://traefik.hill90.com',
    authMethod: 'basic-auth',
    network: 'tailscale',
    ssoStatus: 'not-applicable',
    healthCheck: {
      internalUrl: 'http://traefik:8080',
      path: '/api/rawdata',
    },
  },
  {
    id: 'litellm',
    name: 'LiteLLM',
    purpose: 'AI model routing and admin dashboard',
    url: 'https://litellm.hill90.com',
    authMethod: 'master-key',
    network: 'tailscale',
    ssoStatus: 'limited',
    healthCheck: {
      internalUrl: 'http://litellm:4000',
      path: '/health/liveliness',
    },
  },
]
