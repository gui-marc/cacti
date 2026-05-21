import AccountPage from "@/pages/account-page"
import LoginPage from "@/pages/login-page"
import RegisterPage from "@/pages/register-page"
import { createBrowserRouter } from "react-router"

export const router = createBrowserRouter([
  {
    index: true,
    path: "/",
    Component: AccountPage,
  },
  {
    path: "/register",
    Component: RegisterPage,
  },
  {
    path: "/login",
    Component: LoginPage,
  },
])
