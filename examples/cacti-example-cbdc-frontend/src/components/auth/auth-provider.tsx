import { customerApi } from "@/api/endpoints"
import { authContext } from "@/contexts/auth-context"
import { useQuery } from "@tanstack/react-query"

interface AuthProviderProps {
  children: React.ReactNode
}

export default function AuthProvider({ children }: AuthProviderProps) {
  const { data: currentUser, isPending } = useQuery({
    queryKey: ["currentUser"],
    queryFn: async () => {
      const response = await customerApi.getMe()
      return response.data
    },
  })

  return (
    <authContext.Provider
      value={{
        currentUser,
        isPending,
      }}
    >
      {children}
    </authContext.Provider>
  )
}
