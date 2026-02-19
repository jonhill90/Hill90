import NextAuth from "next-auth"
import Keycloak from "next-auth/providers/keycloak"
import type { JWT } from "next-auth/jwt"

const requiredEnvVars = ["AUTH_KEYCLOAK_ID", "AUTH_KEYCLOAK_SECRET", "AUTH_KEYCLOAK_ISSUER"] as const
const missing = requiredEnvVars.filter((v) => !process.env[v])
if (missing.length > 0) {
  throw new Error(`Missing required env var(s): ${missing.join(", ")}`)
}

async function refreshAccessToken(token: JWT): Promise<JWT> {
  const params = new URLSearchParams({
    client_id: process.env.AUTH_KEYCLOAK_ID!,
    client_secret: process.env.AUTH_KEYCLOAK_SECRET!,
    grant_type: "refresh_token",
    refresh_token: token.refreshToken!,
  })

  const response = await fetch(
    `${process.env.AUTH_KEYCLOAK_ISSUER}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    }
  )

  if (!response.ok) {
    return { ...token, error: "RefreshAccessTokenError" }
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
      clientId: process.env.AUTH_KEYCLOAK_ID!,
      clientSecret: process.env.AUTH_KEYCLOAK_SECRET!,
      issuer: process.env.AUTH_KEYCLOAK_ISSUER!,
    }),
  ],
  callbacks: {
    authorized({ auth, request }) {
      const isProtected = request.nextUrl.pathname.startsWith("/dashboard")
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
      session.accessToken = token.accessToken
      session.error = token.error
      if (session.user) {
        session.user.roles = token.roles
      }
      return session
    },
  },
})
