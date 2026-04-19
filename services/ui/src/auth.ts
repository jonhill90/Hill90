import NextAuth from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import type { JWT } from "next-auth/jwt"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

async function refreshAccessToken(token: JWT): Promise<JWT> {
  const params = new URLSearchParams({
    client_id: requireEnv("AUTH_KEYCLOAK_ID"),
    client_secret: requireEnv("AUTH_KEYCLOAK_SECRET"),
    grant_type: "refresh_token",
    refresh_token: token.refreshToken!,
  })

  const response = await fetch(
    `${requireEnv("AUTH_KEYCLOAK_ISSUER")}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  )

  if (!response.ok) {
    return {
      ...token,
      accessToken: undefined,
      idToken: undefined,
      refreshToken: undefined,
      accessTokenExpires: undefined,
      error: "RefreshAccessTokenError",
    }
  }

  const refreshed = await response.json()

  return {
    ...token,
    accessToken: refreshed.access_token,
    refreshToken: refreshed.refresh_token ?? token.refreshToken,
    accessTokenExpires: Date.now() + refreshed.expires_in * 1000,
    error: undefined,
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Keycloak({
      clientId: process.env.AUTH_KEYCLOAK_ID,
      clientSecret: process.env.AUTH_KEYCLOAK_SECRET,
      issuer: process.env.AUTH_KEYCLOAK_ISSUER,
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const path = request.nextUrl.pathname
      const isProtected =
        path.startsWith("/dashboard") ||
        path.startsWith("/profile") ||
        path.startsWith("/settings") ||
        path.startsWith("/agents") ||
        path.startsWith("/docs") ||
        path.startsWith("/admin")
      if (isProtected && !auth) return false
      return true
    },
    async jwt({ token, account }) {
      // Initial sign-in: persist tokens and roles from Keycloak
      if (account) {
        const decoded = account.access_token
          ? JSON.parse(Buffer.from(account.access_token.split(".")[1], "base64url").toString())
          : {}

        return {
          ...token,
          accessToken: account.access_token,
          idToken: account.id_token,
          refreshToken: account.refresh_token,
          accessTokenExpires: account.expires_at ? account.expires_at * 1000 : Date.now() + 300_000,
          roles: decoded.realm_roles ?? [],
        }
      }

      // Not expired yet — return as-is
      if (token.accessTokenExpires && Date.now() < token.accessTokenExpires) {
        return token
      }

      // Token expired — attempt refresh
      return refreshAccessToken(token)
    },
    async session({ session, token }) {
      session.error = token.error
      if (token.error === "RefreshAccessTokenError") {
        session.accessToken = undefined
        session.idToken = undefined
      } else {
        session.accessToken = token.accessToken
        session.idToken = token.idToken
      }
      if (session.user) {
        session.user.roles = token.roles
        session.user.sub = token.sub
      }
      return session
    },
  },
})
