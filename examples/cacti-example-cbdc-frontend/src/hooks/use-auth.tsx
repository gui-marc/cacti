import { authContext } from "@/contexts/auth-context"
import { use } from "react"

export function useAuth() {
  const auth = use(authContext)

  if (!auth) {
    throw new Error("useAuth must be used within an AuthProvider")
  }

  return auth
}
