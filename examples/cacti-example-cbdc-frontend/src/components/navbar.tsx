import { useAuth } from "@/hooks/use-auth"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu"
import { useLogout } from "@/hooks/use-logout"
import { ChevronDownIcon, LogOutIcon, PiggyBankIcon } from "lucide-react"
import { Avatar, AvatarFallback } from "./ui/avatar"
import { Button } from "./ui/button"

const appName = import.meta.env.VITE_APP_NAME || "CBDC App"

export default function Navbar() {
  return (
    <nav className="border-b bg-background">
      <div className="container mx-auto flex items-center justify-between p-4">
        <h1 className="flex items-center font-bold">
          <PiggyBankIcon className="mr-1.5" /> {appName}
        </h1>
        <UserDropdown />
      </div>
    </nav>
  )
}

function UserDropdown() {
  const { mutate: logout } = useLogout()
  const { currentUser, isPending } = useAuth()

  if (!currentUser || isPending) {
    return null
  }

  const userInitials = currentUser.displayName
    .split(" ")
    .map((name) => name[0])
    .slice(0, 2)
    .join("")
    .toUpperCase()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button className="h-auto p-0 hover:bg-transparent" variant="ghost" />
        }
      >
        <Avatar>
          <AvatarFallback>{userInitials}</AvatarFallback>
        </Avatar>
        <ChevronDownIcon aria-hidden="true" className="opacity-60" size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-foreground">
              {currentUser.displayName}
            </span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {currentUser.taxId}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => logout()} variant="destructive">
            <LogOutIcon aria-hidden="true" className="opacity-60" size={16} />
            <span>logout</span>
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
