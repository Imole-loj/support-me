# Testnet Quickstart Guide

This guide walks you from zero to a confirmed testnet tip on SupportMe using Freighter (or any Stellar Wallets Kit wallet), Friendbot, and testnet USDC.

If you hit any unexpected errors, refer to the [Testnet Troubleshooting & FAQ](testnet-troubleshooting.md).

---

## 1. Install & Configure Freighter Wallet

1. **Install Freighter**: Install the [Freighter browser extension](https://www.freighter.app/) for Chrome, Firefox, Brave, or Edge.
2. **Create or Import an Account**: Follow the prompts to create a new wallet or import an existing recovery phrase.
3. **Switch to Testnet**:
   - Open the Freighter extension.
   - Click the gear icon (**Settings**) in the bottom navigation.
   - Select **Network**.
   - Switch the active network to **Testnet** (RPC URL: `https://soroban-testnet.stellar.org`, Network Passphrase: `Test SDF Network ; September 2015`).

> [!IMPORTANT]
> The app builds and signs transactions targeting `Networks.TESTNET`. A wallet set to Mainnet ("Public") will fail to sign testnet transactions.

---

## 2. Fund Account with Friendbot

A newly generated Stellar public key (`G...`) does not exist on the network ledger until it is funded with starting XLM reserves.

### Option A: Web Browser

Copy your public key (`G...`) from Freighter and visit:

```text
https://friendbot.stellar.org/?addr=YOUR_G_PUBLIC_KEY
```

A JSON response with `status: 200` confirms that 10,000 testnet XLM has been credited to your address.

### Option B: Stellar CLI

If you have the `stellar` CLI installed:

```bash
stellar keys fund <ACCOUNT_NAME_OR_PUBLIC_KEY> --network testnet
```

### Verify Balance

Look up your account on [stellar.expert Testnet Explorer](https://stellar.expert/explorer/testnet):

```text
https://stellar.expert/explorer/testnet/account/YOUR_G_PUBLIC_KEY
```

You should see a balance of 10,000 XLM.

---

## 3. Add a Testnet USDC Trustline

SupportMe supports tipping in both **XLM** and **USDC**. While XLM is native and requires no trustline, holding and transferring USDC requires an explicit trustline to the configured testnet USDC issuer:

- **USDC Code**: `USDC`
- **USDC Issuer (`NEXT_PUBLIC_USDC_ISSUER`)**: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA`

### Adding the Trustline via Freighter

1. In Freighter, click **Manage Assets** (or **Add Asset**).
2. Click **Add Custom Asset**.
3. Enter:
   - **Asset Code**: `USDC`
   - **Issuer Address**: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA`
4. Confirm and sign the transaction in Freighter.

### Adding the Trustline via Stellar CLI

```bash
stellar tx new change-trust \
  --source-account <YOUR_SECRET_OR_ALIAS> \
  --network testnet \
  --line "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA"
```

### Acquiring Testnet USDC

Once the trustline is established:

1. **Circle Testnet Faucet**: Visit [faucet.circle.com](https://faucet.circle.com/), select **Stellar Testnet**, paste your wallet address, and request USDC.
2. **Local Test Anchor**: If running SupportMe locally, you can use the test anchor distribution in [`anchor/`](../anchor/README.md).

---

## 4. Complete Your First End-to-End Tip

### Step 1: Register a Creator Profile

1. Connect your wallet to SupportMe.
2. Navigate to your profile or `/settings`.
3. Choose a unique username (e.g., `alice_dev`) and submit. This calls `register_creator` on the `creator-registry` contract.
4. Ensure both **XLM** and **USDC** are enabled under your accepted assets.

### Step 2: Tip in XLM

1. Open the creator's profile page (e.g., `https://support-mee.vercel.app/alice_dev` or `http://localhost:3000/alice_dev`).
2. Select **XLM** in the currency selector.
3. Choose or enter a tip amount (e.g., `5 XLM`) and an optional memo message.
4. Click **Tip with XLM** and approve the transaction in Freighter.
5. The toast notification will confirm the donation, and the on-chain donation counter on the profile updates live over SSE.

### Step 3: Tip in USDC

1. On the same creator profile, switch the currency selector to **USDC**.
2. Enter a tip amount (e.g., `2 USDC`).
3. Click **Tip with USDC** and approve the transaction in Freighter.
4. Wait for confirmation.

### Step 4: Verify on Stellar.expert

Open [stellar.expert Testnet Explorer](https://stellar.expert/explorer/testnet) and check:

1. **Your Wallet**: Look at transaction history under `/account/YOUR_G_PUBLIC_KEY`. You will see the contract invocations and payment operations.
2. **Donation Contract**: Inspect the deployed donation contract ID (found in [README.md](../README.md#smart-contracts-stellar-testnet)). You will see your `donate` calls and the emitted `donated` events with token addresses and amounts.

---

## Next Steps & Troubleshooting

- Need help with failed simulations, expired allowances, or wallet connection errors? See [Testnet Troubleshooting](testnet-troubleshooting.md).
- Want to learn how recurring subscriptions work on testnet? Check [Architecture Overview](architecture.md).
- Deploying your own contracts? Read the [Contract Deploy Workflow](contract-deploy-workflow.md) and [Testnet Reset Runbook](testnet-reset-runbook.md).
