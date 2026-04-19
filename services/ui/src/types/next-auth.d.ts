import "next-auth"
import "next-auth/jwt"

declare module "next-auth" {
  interface Session {
    accessToken?: string
    idToken?: string
    error?: string
    user: {
      name?: string | null
      email?: string | null
      image?: string | null
      roles?: string[]
      sub?: string
    }
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string
    idToken?: string
    refreshToken?: string
    accessTokenExpires?: number
    roles?: string[]
    error?: string
  }
}
