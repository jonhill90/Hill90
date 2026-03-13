import { auth } from "@/auth"
import { NextResponse } from "next/server"

export default auth((req) => {
  const sessionError = (req.auth as { error?: string } | null)?.error
  const hasAccessToken = Boolean((req.auth as { accessToken?: string } | null)?.accessToken)

  if (!req.auth || sessionError === "RefreshAccessTokenError" || !hasAccessToken) {
    return NextResponse.redirect(new URL("/api/auth/signin", req.url))
  }
})

export const config = {
  matcher: ["/dashboard/:path*", "/profile/:path*", "/settings/:path*", "/agents/:path*", "/docs/:path*", "/admin/:path*"],
}
