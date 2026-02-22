import { auth } from "@/auth"
import { cookies } from "next/headers"
import { NextResponse } from "next/server"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

export async function GET() {
  const session = await auth()

  // Build Keycloak logout URL
  const issuer = requireEnv("AUTH_KEYCLOAK_ISSUER")
  const logoutUrl = new URL(`${issuer}/protocol/openid-connect/logout`)
  const appRoot = new URL("/", requireEnv("AUTH_URL")).toString()

  if (session?.idToken) {
    logoutUrl.searchParams.set("id_token_hint", session.idToken)
  } else {
    logoutUrl.searchParams.set("client_id", requireEnv("AUTH_KEYCLOAK_ID"))
  }
  logoutUrl.searchParams.set("post_logout_redirect_uri", appRoot)

  // Clear ALL Auth.js cookies (including chunked session cookies)
  const response = NextResponse.redirect(logoutUrl)
  const cookieStore = await cookies()
  for (const cookie of cookieStore.getAll()) {
    if (
      cookie.name.startsWith("authjs.") ||
      cookie.name.startsWith("__Secure-authjs.") ||
      cookie.name.startsWith("__Host-authjs.")
    ) {
      response.cookies.set(cookie.name, "", {
        maxAge: 0,
        path: "/",
        secure: cookie.name.startsWith("__Secure-") || cookie.name.startsWith("__Host-"),
      })
    }
  }

  return response
}
