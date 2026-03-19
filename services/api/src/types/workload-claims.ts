/**
 * WorkloadClaims — published contract for agent principal identity.
 *
 * This interface defines the JWT claim shape for all agent-issued tokens.
 * Downstream services (inference, retrieval) should verify tokens against
 * this contract. See docs/architecture/trust-boundaries.md for the full
 * trust boundary model.
 *
 * AI-115: Workload Principal Model for Agents.
 */

/** Formal principal types in the Hill90 identity model. */
export type PrincipalType = 'human' | 'agent' | 'service';

/**
 * JWT claims for agent workload principals.
 *
 * Issued by the API service (Ed25519). Keycloak is NOT the identity provider
 * for agents — see trust boundary doc for authority mapping.
 */
export interface WorkloadClaims {
  /** Principal identifier — agent UUID (V2) or slug (V1). Used as JWT `sub`. */
  sub: string;

  /** Formal principal type. Always 'agent' for workload principals. */
  principal_type: 'agent';

  /** Issuer. Always 'hill90-api'. */
  iss: string;

  /** Target audience identifier (e.g., 'hill90-akm', 'hill90-model-router'). */
  aud: string;

  /** Expiration (epoch seconds). */
  exp: number;

  /** Issued-at (epoch seconds). */
  iat: number;

  /** Unique token ID — used as the revocation handle. */
  jti: string;

  /** Keycloak sub of the owning human principal. For audit attribution only, not privilege derivation. */
  owner: string;

  /** Granted scopes — derived from assigned skill scopes. Flat colon-namespaced strings. */
  scopes: string[];

  /** Request-scoped tracing ID. Present when originating request carries X-Correlation-ID. */
  correlation_id?: string;

  /** Human-readable agent slug. Present when WORKLOAD_PRINCIPAL_V2=true. For log correlation, NOT auth. */
  agent_slug?: string;
}
