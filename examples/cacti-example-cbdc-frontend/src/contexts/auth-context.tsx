import type { User } from "@/api/types"
import { createContext } from "react"

interface AuthContext {
  currentUser: User | null
  login: () => Promise<void>
  logout: () => Promise<void>
}

export const authContext = createContext<AuthContext | undefined>(undefined)
