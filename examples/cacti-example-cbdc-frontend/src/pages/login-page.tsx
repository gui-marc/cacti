import { authApi } from "@/api/endpoints"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { queryClient } from "@/lib/query-client"

import { useForm } from "react-hook-form"
import { useNavigate } from "react-router"
import { toast } from "sonner"

export default function LoginPage() {
  const navigate = useNavigate()

  const { handleSubmit, register } = useForm({
    defaultValues: {
      taxId: "",
      password: "",
    },
  })

  async function onSubmit(data: { taxId: string; password: string }) {
    const response = await authApi.login({
      password: data.password,
      taxId: data.taxId,
    })

    if (response.status === 200) {
      await queryClient.invalidateQueries({
        queryKey: ["currentUser"],
      })

      toast.success(`Welcome back, ${response.data.displayName}!`)

      await navigate("/")
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div className="grid h-svh place-items-center bg-accent">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Login to your account</CardTitle>
            <CardDescription>
              Enter your information below to access your account.
            </CardDescription>
            <CardAction>
              <Button variant="link">Register</Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              <Input {...register("taxId")} placeholder="Tax ID" />
              <Input
                {...register("password")}
                placeholder="Password"
                type="password"
              />
            </FieldGroup>
          </CardContent>
          <CardFooter>
            <Button type="submit">Login</Button>
          </CardFooter>
        </Card>
      </div>
    </form>
  )
}
