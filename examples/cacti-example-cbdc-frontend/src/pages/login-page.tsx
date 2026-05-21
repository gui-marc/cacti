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
import { z } from "zod"
import { FieldGroup } from "@/components/ui/field"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

const loginFormSchema = z.object({
  taxId: z.string().min(1, "Tax ID is required"),
  password: z.string().min(1, "Password is required"),
})

type LoginFormValues = z.infer<typeof loginFormSchema>

export default function LoginPage() {
  const { handleSubmit } = useForm<LoginFormValues>({
    defaultValues: {
      taxId: "",
      password: "",
    },
    resolver: zodResolver(loginFormSchema),
  })

  function onSubmit(data: LoginFormValues) {
    console.log(data)
  }

  return (
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
          <form onSubmit={handleSubmit(onSubmit)}>
            <FieldGroup></FieldGroup>
          </form>
        </CardContent>
        <CardFooter></CardFooter>
      </Card>
    </div>
  )
}
