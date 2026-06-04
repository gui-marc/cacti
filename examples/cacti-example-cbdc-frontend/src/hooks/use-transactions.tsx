import { transactionsApi } from "@/api/endpoints"
import { useQuery } from "@tanstack/react-query"

export function useTransactions() {
  return useQuery({
    queryKey: ["transactions"],
    queryFn: async () => {
      const response = await transactionsApi.listTransactions()
      return response.data
    },
  })
}
