/**
 * Keycloak Account API client.
 *
 * All calls forward the user's own bearer token — no admin service account needed.
 * The Account API base URL is derived from the Keycloak issuer URL:
 *   {issuer}/account  (e.g. https://auth.hill90.com/realms/hill90/account)
 */

export interface KeycloakProfile {
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailVerified?: boolean;
}

function accountUrl(issuer: string): string {
  // issuer is e.g. https://auth.hill90.com/realms/hill90
  return `${issuer}/account`;
}

export async function getKeycloakProfile(
  issuer: string,
  token: string
): Promise<KeycloakProfile> {
  const res = await fetch(accountUrl(issuer), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`Keycloak Account API GET failed: ${res.status}`);
  }
  return res.json() as Promise<KeycloakProfile>;
}

export async function updateKeycloakProfile(
  issuer: string,
  token: string,
  updates: { firstName?: string; lastName?: string }
): Promise<KeycloakProfile> {
  // Account API POST requires full user representation, so GET first then merge
  const current = await getKeycloakProfile(issuer, token);
  const merged = { ...current, ...updates };

  const res = await fetch(accountUrl(issuer), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(merged),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keycloak Account API POST failed: ${res.status} ${text}`);
  }
  // Keycloak returns 204 No Content — return the merged values
  return { firstName: merged.firstName, lastName: merged.lastName };
}
