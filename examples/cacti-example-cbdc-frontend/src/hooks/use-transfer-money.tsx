import { transactionsApi } from "@/api/endpoints"
import { useMutation } from "@tanstack/react-query"
import type { CreateTransactionRequest } from "../../../cacti-example-cbdc-backend/src/main/typescript/generated/openapi/typescript-axios"
import { queryClient } from "@/lib/query-client"
import { toast } from "sonner"
import { AxiosError } from "axios"

export default function useTransferMoney() {
  return useMutation({
    mutationFn: async (req: CreateTransactionRequest) => {
      const response = await transactionsApi.createTransaction(req)
      return response.data
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["transactions"],
      })
      await queryClient.invalidateQueries({
        queryKey: ["balance"],
      })
    },
    onError: (error) => {
      console.error({ error })
      const errorMessage =
        error instanceof AxiosError
          ? error.response?.data?.error
          : "An error occurred while transferring money."
      toast.error(errorMessage)
    },
  })
}
