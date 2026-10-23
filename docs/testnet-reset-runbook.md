# Testnet Reset Recovery Runbook

Stellar Testnet is periodically reset by the Stellar Development Foundation (SDF), wiping all accounts, balances, contracts, and ledger state.

When a testnet reset occurs, SupportMe's deployed contracts (`donation` and `creator-registry`), executor keypair, donor allowances, and database transaction records become invalid. This runbook details how to detect a reset, redeploy the contracts, update production and local environments, and clean up the database.

---

## 1. Detecting a Testnet Reset

A testnet reset can be identified by the following symptoms:

1. **RPC / Explorer Not Found**:
   - Querying previously deployed contract IDs on [stellar.expert](https://stellar.expert/explorer/testnet) or via `stellar contract info` returns `Contract not found` or `Account not found`.
   ```bash
   curl -X POST https://soroban-testnet.stellar.org \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getLedgerEntries","params":{"keys":["..."]}}'
   ```
2. **Backend Health Check Failure**:
   - The `/health` endpoint reports `degraded` or `error`.
   - Backend logs report repeated `Transaction simulation failed: Error(Contract, #1)` or account not found for `SubscriptionExecutor`.
3. **Frontend Invocations Fail**:
   - Users receive "Account not found" or "Contract not found" errors during wallet interactions.

---

## 2. Ordered Recovery Checklist

### Step 1: Regenerate & Fund Required Keypairs

All testnet accounts must be re-funded via Friendbot (`https://friendbot.stellar.org/?addr=<PUBLIC_KEY>`).

1. **Admin / Deployer Key**:
   ```bash
   stellar keys generate ap-deployer --network testnet
   stellar keys fund ap-deployer --network testnet
   ```
2. **Subscription Executor Key**:
   ```bash
   stellar keys generate ap-executor --network testnet
   stellar keys fund ap-executor --network testnet
   ```
   Record the secret key (`EXECUTOR_SECRET_KEY`) for backend deployment.

---

### Step 2: Rebuild & Redeploy Contracts

Follow [`contract-deploy-workflow.md`](contract-deploy-workflow.md) to build and deploy fresh contracts:

```bash
# 1. Compile contracts
rustup target add wasm32v1-none
cargo build --workspace --target wasm32v1-none --release

# 2. Deploy Creator Registry
REGISTRY_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/creator_registry.wasm \
  --source-account ap-deployer --network testnet)

# 3. Deploy Donation Contract
DONATION_ID=$(stellar contract deploy \
  --wasm target/wasm32v1-none/release/donation.wasm \
  --source-account ap-deployer --network testnet)

echo "Registry: $REGISTRY_ID"
echo "Donation: $DONATION_ID"
```

---

### Step 3: Initialize Contracts & Authorize Tokens

1. **Initialize Donation Contract**:

   ```bash
   stellar contract invoke --id $DONATION_ID \
     --source-account ap-deployer --network testnet -- \
     initialize --admin $(stellar keys address ap-deployer) --registry $REGISTRY_ID
   ```

2. **Initialize Creator Registry**:

   ```bash
   stellar contract invoke --id $REGISTRY_ID \
     --source-account ap-deployer --network testnet -- \
     initialize --admin $(stellar keys address ap-deployer) --donation_contract $DONATION_ID
   ```

3. **Authorize Subscription Executor**:

   ```bash
   stellar contract invoke --id $DONATION_ID \
     --source-account ap-deployer --network testnet -- \
     set_executor --new_executor $(stellar keys address ap-executor)
   ```

4. **Add Tokens to Allowlist**:
   ```bash
   # Add Native XLM SAC
   NATIVE_SAC="CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
   stellar contract invoke --id $DONATION_ID \
     --source-account ap-deployer --network testnet -- \
     add_token --token $NATIVE_SAC
   ```

---

### Step 4: Database Clean-Up & Cursor Reset

Because testnet transaction hashes and allowances no longer exist:

1. **Archive or Clear Stale Database Records**:
   Connect to your PostgreSQL database (Railway or local):
   ```sql
   -- Clear or archive orphaned transactions
   DELETE FROM "Donation";

   -- Clear subscriptions whose on-chain allowances were wiped
   DELETE FROM "Subscription";

   -- Reset creator cached statistics
   UPDATE "Creator" SET "donationGoal" = NULL;
   ```
2. **Reset the Soroban Event Listener Cursor**:
   - Query the current testnet ledger sequence:
     ```bash
     curl -s -X POST https://soroban-testnet.stellar.org \
       -H "Content-Type: application/json" \
       -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq .result.sequence
     ```
   - Update `SOROBAN_START_LEDGER` to the current sequence number so the listener begins from the fresh ledger.

---

### Step 5: Update Environment Variables

#### Railway (Backend)

Update the following environment variables in the Railway dashboard:

- `NEXT_PUBLIC_DONATION_CONTRACT_ID`: `$DONATION_ID`
- `NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID`: `$REGISTRY_ID`
- `EXECUTOR_SECRET_KEY`: Private key of `ap-executor`
- `SOROBAN_START_LEDGER`: Sequence number of the new deployment ledger

#### Vercel (Frontend)

Update the following environment variables in Vercel:

- `NEXT_PUBLIC_DONATION_CONTRACT_ID`: `$DONATION_ID`
- `NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID`: `$REGISTRY_ID`

Redeploy both services after updating environment variables.

---

### Step 6: Local Anchor Setup (If Applicable)

If using the local test anchor for SEP-24 fiat cash-outs:

```bash
cd anchor
./setup.sh
```

This funds fresh anchor keypairs and issues new testnet USDC assets.

---

### Step 7: Update Documentation & Contract Table

Update the contract table in [README.md](../README.md#smart-contracts-stellar-testnet):

- **Never delete old rows**: Mark wiped/pre-reset contracts with `(wiped / testnet reset)` so audit logs and historical commits remain clear.
- Append new rows with the newly deployed contract IDs and transaction hashes.

---

## References

- [Contract Deploy Workflow](contract-deploy-workflow.md)
- [Production Runbook](production-runbook.md)
- [Testnet Troubleshooting & FAQ](testnet-troubleshooting.md)
- [Testnet Quickstart](testnet-quickstart.md)
