import type { User } from "@/api/types"
import { authContext } from "@/contexts/auth-context"
import { sleep } from "@/lib/utils"
import { useState } from "react"

interface AuthProviderProps {
  children: React.ReactNode
}

export default function AuthProvider({ children }: AuthProviderProps) {
  const [currentUser, setCurrentUser] = useState<User | null>(null)

  async function login() {
    await sleep(200)
    setCurrentUser({ id: "1", name: "John Doe" })
  }

  async function logout() {
    await sleep(200)
    setCurrentUser(null)
  }

  return (
    <authContext.Provider
      value={{
        currentUser,
        login,
        logout,
      }}
    >
      {children}
    </authContext.Provider>
  )
}
