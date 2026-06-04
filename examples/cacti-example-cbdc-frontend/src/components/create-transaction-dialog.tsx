import { useBesuBalance } from "@/hooks/use-besu-balance"
import { Button } from "./ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog"
import { Field, FieldDescription, FieldGroup } from "./ui/field"
import { Input } from "./ui/input"
import { Label } from "./ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select"
import { Separator } from "./ui/separator"
import { useEthereumBalance } from "@/hooks/use-ethereum-balance"
import { useForm } from "react-hook-form"
import useTransferMoney from "@/hooks/use-transfer-money"
import { Spinner } from "./ui/spinner"
import { useState } from "react"

type AccountType = "besu" | "ethereum"

type FormValues = {
  senderChain: AccountType
  receiverChain: AccountType
  receiverAddress: string
  amount: number
}

export default function CreateTransactionDialog({
  children,
}: {
  children: React.ReactNode
}) {
  const { mutateAsync, isPending } = useTransferMoney()

  const [senderChain, setSenderChain] = useState<AccountType>("besu")
  const { register, handleSubmit } = useForm<FormValues>({
    defaultValues: {
      senderChain: "besu",
      receiverChain: "ethereum",
      receiverAddress: "",
      amount: 0,
    },
  })

  const { data: besuBalance } = useBesuBalance()
  const { data: ethereumBalance } = useEthereumBalance()

  const currentAccount = senderChain === "besu" ? besuBalance : ethereumBalance

  async function onSubmit(data: FormValues) {
    await mutateAsync({
      amount: data.amount,
      receiverAddress: data.receiverAddress,
      destinationChain: data.receiverChain,
      sourceChain: senderChain,
    })
  }

  return (
    <Dialog>
      {children}
      <DialogContent
        className="sm:max-w-sm"
        render={<form onSubmit={handleSubmit(onSubmit)} />}
      >
        <DialogHeader>
          <DialogTitle>Send Money</DialogTitle>
          <DialogDescription>
            Send money to an account on another chain
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <Label htmlFor="name-1">Account from</Label>
            <Select
              disabled={isPending}
              defaultValue={senderChain}
              onValueChange={(value) => setSenderChain(value as AccountType)}
              {...register("senderChain")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="besu">Besu (CBDC A)</SelectItem>
                <SelectItem value="ethereum">Ethereum (CBDC B)</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription className="font-mono text-sm text-muted-foreground">
              Balance: {currentAccount?.balance}
            </FieldDescription>
          </Field>
          <Separator />
          <Field>
            <Label htmlFor="name-1">Receiver chain</Label>
            <Select
              {...register("receiverChain")}
              name="receiver-chain"
              defaultValue="ethereum"
              disabled={isPending}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="besu">Besu (CBDC A)</SelectItem>
                <SelectItem value="ethereum">Ethereum (CBDC B)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <Label htmlFor="receiver-address">Receiver address</Label>
            <Input
              id="receiver-address"
              placeholder="0x0000000000000000000000000000000000000000"
              disabled={isPending}
              {...register("receiverAddress")}
            />
          </Field>
          <Field>
            <Label htmlFor="amount">Amount</Label>
            <Input
              id="amount"
              type="number"
              placeholder="0"
              disabled={isPending}
              {...register("amount", { valueAsNumber: true })}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button type="submit" disabled={isPending}>
            Send {isPending && <Spinner/>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
