import NextAuth from "next-auth"
import Keycloak from "next-auth/providers/keycloak"

const requiredEnvVars = ["AUTH_KEYCLOAK_ID", "AUTH_KEYCLOAK_SECRET", "AUTH_KEYCLOAK_ISSUER"] as const
const missing = requiredEnvVars.filter((v) => !process.env[v])
if (missing.length > 0) {
  throw new Error(`Missing required env var(s): ${missing.join(", ")}`)
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Keycloak({
      clientId: process.env.AUTH_KEYCLOAK_ID!,
      clientSecret: process.env.AUTH_KEYCLOAK_SECRET!,
      issuer: process.env.AUTH_KEYCLOAK_ISSUER!,
    }),
  ],
})
