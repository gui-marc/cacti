import Protected from "@/components/auth/protected"
import { useAuth } from "@/hooks/use-auth"
import { useBesuBalance } from "@/hooks/use-besu-balance"
import { useEthereumBalance } from "@/hooks/use-ethereum-balance"
import { useTransactions } from "@/hooks/use-transactions"
import { useState } from "react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  HandCoinsIcon,
  BanknoteArrowDown,
  BanknoteArrowUp,
  ArrowRightLeftIcon,
  CheckIcon,
  CopyIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"
import CreateTransactionDialog from "@/components/create-transaction-dialog"
import { DialogTrigger } from "@/components/ui/dialog"
import ChainBadge from "@/components/chain-badge"
import Navbar from "@/components/navbar"

type AccountType = "besu" | "ethereum"

export default function AccountPage() {
  const [accountType, setAccountType] = useState<AccountType>("besu")

  const { data: besuBalance } = useBesuBalance()
  const { data: ethereumBalance } = useEthereumBalance()
  const { data: transactions } = useTransactions()

  const currentAccount = accountType === "besu" ? besuBalance : ethereumBalance

  // Only the legs that touch the selected chain's account: a cross-chain
  // transfer is a debit on the source account and a credit on the destination.
  const account = currentAccount?.account?.toLowerCase()
  const accountTransactions = (transactions ?? []).flatMap((transaction) => {
    const isSent =
      transaction.sourceChain === accountType &&
      transaction.senderAddress.toLowerCase() === account
    const isReceived =
      transaction.destinationChain === accountType &&
      transaction.receiverAddress.toLowerCase() === account

    if (!isSent && !isReceived) return []
    return [{ transaction, isReceived: !isSent }]
  })

  return (
    <Protected>
      <Navbar />
      <div className="bg-accent">
        <div className="container mx-auto py-10">
          <Tabs className="mb-6">
            <TabsList>
              <TabsTrigger onClick={() => setAccountType("besu")} value="besu">
                Besu
              </TabsTrigger>
              <TabsTrigger
                onClick={() => setAccountType("ethereum")}
                value="ethereum"
              >
                Ethereum
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-start justify-between gap-6">
            <div>
              <p className="mb-1 text-sm text-muted-foreground">
                Available Balance
              </p>
              <h1 className="font-mono text-3xl font-bold">
                {Number(currentAccount?.balance).toFixed(2)}
              </h1>
              <p className="flex items-center gap-1 text-sm text-muted-foreground">
                {currentAccount?.account}
                {currentAccount?.account && (
                  <CopyButton
                    key={currentAccount.account}
                    value={currentAccount.account}
                  />
                )}
              </p>
            </div>

            <CreateTransactionDialog>
              <DialogTrigger
                render={
                  <Button size="sm">
                    Transfer <ArrowRightLeftIcon />
                  </Button>
                }
              />
            </CreateTransactionDialog>
          </div>
        </div>
      </div>
      <div>
        <div className="container mx-auto py-10">
          <div className="mb-6">
            <h2 className="font-bold">Transactions</h2>
            <p className="text-muted-foreground">
              Your recent transaction history
            </p>
          </div>

          {accountTransactions.length === 0 && <TransactionsEmpty />}

          <Table>
            <TableBody>
              {accountTransactions.map(({ transaction, isReceived }) => {
                return (
                  <TableRow key={transaction.id}>
                    <TableCell>
                      <EmptyMedia
                        variant="icon"
                        className={
                          isReceived
                            ? "bg-green-500/10 text-green-600 dark:text-green-400"
                            : "bg-red-500/10 text-red-600 dark:text-red-400"
                        }
                      >
                        {isReceived ? (
                          <BanknoteArrowDown />
                        ) : (
                          <BanknoteArrowUp />
                        )}
                      </EmptyMedia>
                    </TableCell>
                    <TableCell>
                      <p className="font-mono font-medium">
                        {isReceived ? "+" : "-"}
                        {(isReceived
                          ? transaction.destinationAmount
                          : transaction.amount
                        ).toFixed(2)}
                      </p>
                      <p className="text-sm text-muted-foreground">Amount</p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{transaction.status}</p>
                      <p className="text-sm text-muted-foreground">Status</p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">
                        <ChainBadge chain={transaction.sourceChain} />
                      </p>
                      <p className="text-sm text-muted-foreground">Source</p>
                    </TableCell>
                    <TableCell>
                      {!isReceived && (
                        <>
                          <p className="font-medium">
                            <ChainBadge chain={transaction.destinationChain} />{" "}
                            {transaction.receiverAddress.slice(0, 6)}...
                          </p>
                          <p className="text-sm text-muted-foreground">
                            Destination
                          </p>
                        </>
                      )}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">
                        {formatTimestamp(transaction.createdAt)}
                      </p>
                      <p className="text-sm text-muted-foreground">Date</p>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </Protected>
  )
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Copy account number"
      onClick={copy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  )
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })
}

function TransactionsEmpty() {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <HandCoinsIcon />
        </EmptyMedia>
        <EmptyTitle>No transactions found</EmptyTitle>
        <EmptyDescription>
          It looks like you haven&apos;t made any transactions yet.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button>Send Money</Button>
      </EmptyContent>
    </Empty>
  )
}
