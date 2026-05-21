import { useAuth } from "@/hooks/use-auth"
import { Navigate } from "react-router"

export default function Protected({ children }: { children: React.ReactNode }) {
  const { currentUser } = useAuth()

  if (!currentUser) {
    return <Navigate to="/login" />
  }

  return children
}
