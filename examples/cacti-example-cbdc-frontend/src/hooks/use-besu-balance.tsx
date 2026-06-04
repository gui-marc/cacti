import { customerApi } from "@/api/endpoints"
import { useQuery } from "@tanstack/react-query"

export function useBesuBalance() {
  return useQuery({
    queryKey: ["balance", "besu"],
    queryFn: async () => {
      const response = await customerApi.getBalance("besu")
      return response.data
    },
  })
}
