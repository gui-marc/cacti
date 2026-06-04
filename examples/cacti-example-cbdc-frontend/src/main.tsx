import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import { RouterProvider } from "react-router"
import { router } from "./routes"
import AuthProvider from "./components/auth/auth-provider"
import { QueryClientProvider } from "@tanstack/react-query"
import { queryClient } from "./lib/query-client"
import { Toaster } from "./components/ui/sonner"

document.title = import.meta.env.VITE_APP_NAME || "Cacti CBDC Example"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
)
