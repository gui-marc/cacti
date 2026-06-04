import { customerApi } from "@/api/endpoints"
import { useQuery } from "@tanstack/react-query"

export function useEthereumBalance() {
  return useQuery({
    queryKey: ["balance", "ethereum"],
    queryFn: async () => {
      const response = await customerApi.getBalance("ethereum")
      return response.data
    },
  })
}
