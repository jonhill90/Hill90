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
  // Account API requires a full PUT with all fields, so GET first then merge
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
  return res.json() as Promise<KeycloakProfile>;
}

export async function changeKeycloakPassword(
  issuer: string,
  token: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const url = `${accountUrl(issuer)}/credentials/password`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      currentPassword,
      newPassword,
      confirmation: newPassword,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400) {
      throw new Error('Invalid current password or password policy not met');
    }
    throw new Error(`Keycloak password change failed: ${res.status} ${text}`);
  }
}
