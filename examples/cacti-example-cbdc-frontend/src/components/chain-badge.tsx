import { Badge } from "./ui/badge"

export type Chain = "besu" | "ethereum"

export default function ChainBadge({ chain }: { chain: Chain }) {
  if (chain === "besu") {
    return <Badge variant="default">BESU</Badge>
  }

  return <Badge variant="secondary">ETH</Badge>
}
