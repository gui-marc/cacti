# cacti-example-cbdc-backend

Example backend for the CBDC controller plugin. Hosts two **central bank**
processes (one per ledger) and N **commercial-bank partner** processes that
serve a user-facing HTTP API for a frontend.

## Architecture

```text
+-----------+    +-------------+        +-----------+    +-------------+
|  Browser  |--->|  Partner A  |--HMAC->|   CB Besu |--->| Besu ledger |
+-----------+    | :5100       |--HMAC->| :4100     |    +-------------+
                 |  /auth      |        |  /cbdc/*  |
                 |  /balance   |        +-----------+
                 |  /tx        |              |
                 |  /compliance|<--HMAC-------+ (compliance callback)
                 +-------------+
                       |
                       +--HMAC--> CB Ethereum :4200 ----> Geth ledger
```

- **CB Besu / CB Ethereum** each embed a `PluginCBDCController` plus their own
  in-process SATP Hermes gateway. Routing rule: a partner submits a transfer
  to the CB whose chain matches the *source* chain.
- **Partners** are commercial banks. They hold custodial wallets, expose a
  cookie-session user API to the frontend, sign outbound requests to the CBs,
  and serve the inbound `/compliance/check` signed-envelope endpoint the CB
  calls back during compliance checks.

## Running locally

The fastest way to bring up the whole stack is the **all-in-one** entry
point — one Node process that starts Besu + Geth ledger containers,
deploys CBDC + wrapper contracts, mints initial supply, runs the SATP
Hermes gateway, the CBDC controller, and two partner Express apps.

```bash
yarn install
yarn all-in-one
```

Then point your frontend at:

- `http://localhost:5100` — partner A (Alice, Bob)
- `http://localhost:5200` — partner B (Carol)

All seeded users have password `demo`. Ctrl-C tears everything down.

### Multi-process mode (advanced)

For multi-process development with separate CB / partner processes, use
the per-role entry points after deploying contracts and filling in
runtime configs:

```bash
yarn setup                  # writes runtime/*.json skeletons with HMAC secrets
# Deploy CBDC contracts onto running ledgers (Besu + Geth) and fill the
# contract / wrapper addresses + signing keys into the generated configs.
# Use src/test/typescript/satp-e2e.test.ts as a known-good template.
yarn dev                    # starts cb-besu, cb-eth, partner-a, partner-b
```

The frontend lives in `examples/cacti-example-cbdc-frontend` and talks to a
partner over HTTP+cookie. The partner API is described in
`src/main/json/openapi.json`; run `yarn codegen` to regenerate the
typescript-axios client.

## Layout

- `entry/` — process entry points (`central-bank.ts`, `partner.ts`, `setup.ts`, `teardown.ts`)
- `central-bank/` — CB app wiring + FX strategy
- `partner/` — partner Express app, services (auth, balance, compliance, controller-client)
- `infrastructure/` — `ILedgerEnvironment` adapters (Besu, Ethereum) and SATP gateway factory
- `store/sqlite/` — `better-sqlite3` implementations of the controller stores plus partner-only `customers`, `sessions`, `partner_transactions`
- `config/` — runtime config types and loader
- `runtime/` — generated per-process JSON configs (gitignored)

## Status

This package ships the structural pieces of the example end-to-end. The
contract-deploy step in `entry/setup.ts` is currently a config-only stub —
contract addresses and signing keys need to be filled in after deploying
`SATPTokenContract` and `SATPWrapperContract` on each running ledger. Use the
integration test at
`packages/cacti-plugin-cbdc-controller/src/test/typescript/integration/constant-fx-provision.test.ts`
as a known-good template for the deploy + grant + mint sequence.
