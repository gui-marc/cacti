import { createContext } from "react"
import type { MeResponse } from "../../../cacti-example-cbdc-backend/src/main/typescript/generated/openapi/typescript-axios"

interface AuthContext {
  currentUser: MeResponse | undefined
  isPending: boolean
}

export const authContext = createContext<AuthContext | undefined>(undefined)
