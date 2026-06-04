import { authApi } from "@/api/endpoints"
import { useMutation } from "@tanstack/react-query"
import { useNavigate } from "react-router"
import { toast } from "sonner"

export function useLogout() {
  const navigate = useNavigate()

  return useMutation({
    mutationKey: ["logout"],
    mutationFn: async () => {
      const response = await authApi.logout()
      return response.data
    },
    onSuccess: () => {
      navigate("/login")
    },
    onError: (error) => {
      console.error({ error })
      toast.error("An error occurred while logging out. Please try again.")
    },
  })
}
