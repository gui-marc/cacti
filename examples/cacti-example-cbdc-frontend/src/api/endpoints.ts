// todo: fix import paths
import {
  AuthApiFactory,
  CustomerApiFactory,
  ComplianceApiFactory,
  TransactionsApiFactory,
} from "../../../cacti-example-cbdc-backend/src/main/typescript/generated/openapi/typescript-axios"
import axios from "axios"

const BASE_PATH = import.meta.env.VITE_BACKEND_URL || ""

const client = axios.create({
  baseURL: BASE_PATH,
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
})

const authApi = AuthApiFactory(undefined, BASE_PATH, client)
const customerApi = CustomerApiFactory(undefined, BASE_PATH, client)
const complianceApi = ComplianceApiFactory(undefined, BASE_PATH, client)
const transactionsApi = TransactionsApiFactory(undefined, BASE_PATH, client)

export { authApi, customerApi, complianceApi, transactionsApi }
