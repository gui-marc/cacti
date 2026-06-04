import { useAuth } from "@/hooks/use-auth"
import { Navigate } from "react-router"

export default function Protected({ children }: { children: React.ReactNode }) {
  const { currentUser, isPending } = useAuth()

  if (!currentUser && isPending) {
    return <div>Loading...</div>
  }

  if (!currentUser) {
    return <Navigate to="/login" />
  }

  return children
}
