# Production Runbook

This runbook documents common production failure modes for SupportMe, including detection methods and step-by-step response procedures.

## Table of Contents

- [RPC Outage](#rpc-outage)
- [Database Connectivity Issues](#database-connectivity-issues)
- [Failed Recurring-Charge Job](#failed-recurring-charge-job)
- [Bad Deploy](#bad-deploy)
- [Smart Contract Errors](#smart-contract-errors)
- [SSE (Server-Sent Events) Issues](#sse-server-sent-events-issues)
- [Executor Key Issues](#executor-key-issues)
- [Testnet Reset Recovery](testnet-reset-runbook.md)

---

## RPC Outage

### Impact

- `SorobanEventListener` cannot poll for donation events → real-time dashboard updates stop
- `SubscriptionExecutor` cannot charge recurring donations → subscription payments fail
- Frontend cannot submit transactions to Stellar network
- Health check returns `degraded` status

### Detection

**Symptoms:**

- `/health` endpoint returns `status: "degraded"` with `sorobanRpc.status: "error"`
- Dashboard and profile pages stop showing live donations
- Recurring donations fail with `lastError` containing RPC-related messages
- Backend logs show: `SorobanEventListener: poll failed: Soroban RPC getEvents failed: ...`

**Monitoring:**

- Check `/health` endpoint: `curl https://your-backend.com/health`
- Review backend logs for RPC errors
- Monitor `SubscriptionExecutor` logs for charge failures

### Response Steps

1. **Verify RPC Status**

   ```bash
   # Check if Soroban RPC is reachable
   curl -X POST https://soroban-testnet.stellar.org \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}'
   ```

2. **Check Environment Variables**
   - Verify `SOROBAN_RPC_URL` is set correctly on Railway/Vercel
   - Verify `DONATION_CONTRACT_ID` is set (backend) and
     `NEXT_PUBLIC_DONATION_CONTRACT_ID` is set (frontend)

3. **If RPC is Down (External Issue)**
   - The system will automatically retry (polling continues every 5s for events, 60s for subscriptions)
   - No manual intervention required - operations will resume when RPC recovers
   - Event listener uses cursor-based pagination, so no events will be missed during outage
   - Consider switching to a backup RPC if available

4. **If RPC URL is Misconfigured**
   - Update `SOROBAN_RPC_URL` in Railway environment variables
   - Update `NEXT_PUBLIC_SOROBAN_RPC_URL` in Vercel environment variables
   - Restart the backend service on Railway

5. **Verify Recovery**
   - Check `/health` returns `status: "ok"`
   - Monitor logs for successful event polling
   - Verify dashboard shows live donations again

### Prevention

- Set up alerts for `/health` endpoint degradation
- Consider using multiple RPC endpoints with fallback logic
- Monitor RPC provider status pages

---

## Database Connectivity Issues

### Impact

- All backend API endpoints fail (authentication, creator profiles, donations, subscriptions)
- `SubscriptionExecutor` cannot query or update subscription records
- `SorobanEventListener` continues running but cannot correlate events with creators
- Frontend shows 500 errors or timeouts

### Detection

**Symptoms:**

- All API endpoints return 500 errors
- Backend logs show Prisma connection errors: `Can't reach database server`
- Health check may fail if DB check is implemented
- Authentication fails even with valid signatures

**Monitoring:**

- Check Railway logs for database connection errors
- Monitor Railway database status
- Test database connectivity: `npx prisma db push --skip-generate` (from local)

### Response Steps

1. **Check Database Status**
   - Go to Railway dashboard → PostgreSQL service
   - Check if database is running and accessible
   - Review Railway status page for outages

2. **Verify Connection String**
   - Check `DATABASE_URL` in Railway environment variables
   - Ensure format is correct: `postgresql://user:password@host:port/database`
   - Test connection locally with the same credentials

3. **If Database is Down (Railway Issue)**
   - Check Railway status page for ongoing incidents
   - Restart the PostgreSQL service from Railway dashboard
   - Contact Railway support if issue persists

4. **If Connection String is Invalid**
   - Update `DATABASE_URL` in Railway environment variables
   - Restart the backend service
   - Run `npx prisma db push` to verify schema is intact

5. **Check Database Schema**

   ```bash
   # From backend directory
   npx prisma db push --skip-generate
   ```

6. **Verify Recovery**
   - Test `/health` endpoint
   - Test authentication flow
   - Verify API endpoints respond correctly

### Prevention

- Set up database connection pooling
- Implement database health checks in `/health` endpoint
- Monitor database connection metrics
- Keep database backups (see `docs/database-backups.md`)

---

## Failed Recurring-Charge Job

### Impact

- Subscriptions are not charged when due
- Creators don't receive recurring donation payments
- Supporters may see payment failures in their subscription management
- Accumulation of due subscriptions if issue persists

### Detection

**Symptoms:**

- Backend logs show: `SubscriptionExecutor: could not process subscription {id}: ...`
- Database records show `lastError` field populated on subscriptions
- `nextChargeAt` is in the past but `lastChargedAt` is not updated
- Supporters receive payment failure emails (if notifications are configured)

**Monitoring:**

- Query database for stuck subscriptions:
  ```sql
  SELECT * FROM "Subscription"
  WHERE active = true
  AND next_charge_at <= NOW()
  AND last_charged_at < NOW() - INTERVAL '1 hour';
  ```

### Response Steps

1. **Check Executor Configuration**
   - Verify `EXECUTOR_SECRET_KEY` is set in Railway environment variables
   - Verify `DONATION_CONTRACT_ID` is set correctly
   - Verify executor key has sufficient XLM for transaction fees

2. **Check RPC Status**
   - Follow RPC Outage response steps above
   - Subscription executor requires RPC to submit transactions

3. **Review Specific Failure**

   ```sql
   -- Check specific subscription errors
   SELECT id, "supporterAddress", "lastError", "nextChargeAt"
   FROM "Subscription"
   WHERE "lastError" IS NOT NULL;
   ```

4. **Common Failure Types**

   **Insufficient Allowance:**
   - Error: "transfer_from failed" or similar
   - Action: Supporter must re-approve allowance on-chain
   - No backend fix required - user action needed

   **RPC Timeout:**
   - Error: "Transaction did not confirm within 30s"
   - Action: Check RPC status, executor will retry automatically
   - May need to increase timeout if RPC is slow

   **Executor Key Issue:**
   - Error: "Account not found" or "insufficient fee"
   - Action: Fund executor key with XLM for fees
   - Verify executor key is correct

5. **Manual Charge (If Needed)**
   - If executor is down for extended period, consider manual intervention
   - Use backend admin tools or direct contract calls to charge overdue subscriptions
   - Update `nextChargeAt` after successful manual charge

6. **Verify Recovery**
   - Monitor logs for successful charges
   - Check database for updated `lastChargedAt` timestamps
   - Verify `lastError` is cleared after successful charges

### Prevention

- Set up alerts for subscription charge failures
- Monitor executor key balance (auto-fund if low)
- Implement retry logic with exponential backoff (already exists)
- Consider circuit breaker if RPC is consistently failing

---

## Bad Deploy

### Impact

- New code introduces bugs or breaking changes
- Frontend or backend becomes partially or fully non-functional
- Database schema changes may cause errors
- Environment variable changes may break integrations

### Detection

**Symptoms**

- Frontend shows errors or blank pages
- API endpoints return unexpected errors
- Build failures in CI/CD
- Increased error rates in logs
- User reports of broken functionality

**Monitoring**

- CI/CD pipeline status (GitHub Actions)
- Vercel deployment logs
- Railway deployment logs
- Error tracking (if implemented, e.g., Sentry)

### Response Steps

1. **Identify the Bad Deploy**
   - Check Vercel deployments for recent changes
   - Check Railway deployments for recent changes
   - Review GitHub Actions for recent commits
   - Correlate user reports with deployment timeline

2. **Immediate Rollback**

   **Frontend (Vercel):**
   - Go to Vercel dashboard → Deployments
   - Find the last known good deployment
   - Click "..." → "Promote to Production" or "Rollback"
   - Wait for deployment to complete

   **Backend (Railway):**
   - Go to Railway dashboard → backend service
   - Click "Deployments" tab
   - Find the last known good deployment
   - Click "Redeploy" on that commit
   - Alternatively, revert the commit and push

3. **Database Schema Issues**
   - If a bad migration was applied:
     - Check `docs/database-backups.md` for restore procedures
     - Restore from backup if schema is corrupted
     - Revert the migration in code
   - If using `prisma db push` (no migrations):
     - Revert schema changes in `prisma/schema.prisma`
     - Run `npx prisma db push` to restore previous schema

4. **Environment Variable Issues**
   - Check Railway environment variables for recent changes
   - Revert any problematic variable changes
   - Restart the backend service

5. **Verify Rollback**
   - Test critical user flows (auth, donate, dashboard)
   - Check `/health` endpoint
   - Monitor logs for errors
   - Verify frontend loads correctly

6. **Post-Mortem**
   - Identify root cause of the bad deploy
   - Add tests to prevent regression
   - Consider adding staging environment
   - Update runbook if new failure mode discovered

### Prevention

- Implement staging environment for pre-production testing
- Add comprehensive test coverage (unit, integration, e2e)
- Use feature flags for risky changes
- Implement canary deployments
- Add database migration rollback procedures
- Monitor deployment success rates

---

## Smart Contract Errors

### Impact

- Donations fail to settle on-chain
- Subscription operations fail
- Cross-contract calls fail
- Users cannot interact with the platform

### Detection

**Symptoms**

- Frontend shows contract simulation errors
- Transactions fail on Stellar explorer
- Backend logs show contract invocation failures
- Specific error messages from Soroban SDK

**Monitoring**

- Check Stellar explorer for failed transactions
- Monitor backend logs for contract errors
- Test contract calls directly via RPC

### Response Steps

1. **Identify Contract Error**
   - Check transaction on Stellar explorer (e.g., stellar.expert)
   - Review error details in transaction result
   - Check backend logs for detailed error messages

2. **Common Contract Errors**

   **Contract Not Deployed:**
   - Error: "Contract not found" or "Invalid contract address"
   - Action: Verify contract addresses in environment variables
   - Check if contracts are deployed to correct network (testnet vs mainnet)

   **Authorization Failed:**
   - Error: "Host not authorized" or similar
   - Action: Check if executor is set correctly in contract
   - Verify cross-contract call permissions

   **Insufficient Funds:**
   - Error: "Insufficient balance" or "transfer failed"
   - Action: Check user wallet balance
   - Verify token allowance for subscriptions

   **Invalid Parameters:**
   - Error: "Invalid input" or "Type mismatch"
   - Action: Check frontend contract call parameters
   - Verify data types match contract expectations

3. **If Contract is Bugged**
   - Contracts are immutable once deployed
   - Deploy new contract version
   - Update environment variables to point to new contract
   - Migrate state if needed (design contracts to support migration)
   - Update frontend to use new contract addresses

4. **Verify Recovery**
   - Test contract calls with small amounts
   - Verify transactions settle successfully
   - Check that cross-contract calls work
   - Update documentation with new contract addresses

### Prevention

- Thoroughly test contracts before deployment
- Use testnet extensively before mainnet deployment
- Implement contract upgrade patterns
- Add comprehensive contract tests
- Audit contracts before mainnet deployment

---

## SSE (Server-Sent Events) Issues

### Impact

- Real-time dashboard updates stop working
- Profile pages don't show live donations
- Users must refresh to see new donations
- Event listener may be down or disconnected

### Detection

**Symptoms**

- Dashboard doesn't update when new donations occur
- Profile pages show stale data
- Browser console shows SSE connection errors
- Backend logs show event listener errors

**Monitoring**

- Check backend logs for `SorobanEventListener` errors
- Test SSE endpoint directly: `curl https://your-backend.com/api/events`
- Monitor number of active SSE connections

### Response Steps

1. **Check Event Listener Status**
   - Review backend logs for: `SorobanEventListener: polling ...`
   - If warning appears: `DONATION_CONTRACT_ID is not set`
   - Check if listener is running in `server.ts`

2. **Check RPC Connectivity**
   - Event listener depends on RPC
   - Follow RPC Outage response steps above

3. **Restart Event Listener**
   - Restart the backend service on Railway
   - This will restart the event listener

4. **Verify SSE Endpoint**

   ```bash
   # Test SSE endpoint
   curl -N https://your-backend.com/api/events
   ```

5. **Check Frontend SSE Connection**
   - Open browser DevTools → Network tab
   - Filter by "eventsource" or "events"
   - Check connection status and error messages

6. **Verify Recovery**
   - Monitor logs for successful event polling
   - Test dashboard with a new donation
   - Verify SSE connection is established

### Prevention

- Add health check for SSE endpoint
- Monitor event listener uptime
- Add reconnection logic in frontend (already exists with EventSource)
- Alert on SSE connection failures

---

## Executor Key Issues

### Impact

- Recurring donations cannot be charged
- `SubscriptionExecutor` fails to start
- All subscription payments fail

### Detection

**Symptoms**

- Backend logs: `EXECUTOR_SECRET_KEY is not set, recurring donations will not be charged`
- Subscription charges fail with "executor not authorized" errors
- `SubscriptionExecutor` doesn't start

**Monitoring**

- Check backend logs on startup
- Verify `EXECUTOR_SECRET_KEY` is set in Railway
- Monitor subscription charge failures

### Response Steps

1. **Check Executor Key Configuration**
   - Verify `EXECUTOR_SECRET_KEY` is set in Railway environment variables
   - Ensure it's a valid Stellar secret key (starts with 'S')

2. **If Key is Missing**
   - Generate a new keypair:
     ```javascript
     // Use Stellar SDK or stellar-cli
     const Keypair = require("@stellar/stellar-sdk").Keypair;
     const keypair = Keypair.random();
     console.log("Secret:", keypair.secret());
     console.log("Public:", keypair.publicKey());
     ```
   - Set `EXECUTOR_SECRET_KEY` in Railway
   - Restart backend service

3. **If Key is Compromised**
   - Immediately rotate to a new keypair
   - Update contract to authorize new executor (via `set_executor`)
   - Update `EXECUTOR_SECRET_KEY` in Railway
   - Restart backend service

4. **Fund Executor Key**
   - Executor key needs XLM for transaction fees
   - Fund from a wallet: `stellar-cli payment --destination <executor_public> --amount 10`
   - Monitor balance and auto-fund if needed

5. **Verify Executor is Authorized in Contract**
   - Check contract state to verify executor is set
   - If not set, call `set_executor` on the donation contract
   - This requires admin privileges on the contract

6. **Verify Recovery**
   - Check logs: `SubscriptionExecutor: charging due subscriptions every ...`
   - Monitor successful subscription charges
   - Verify executor public key matches contract authorization

### Prevention

- Never commit executor secret key to git
- Use secrets management (Railway environment variables)
- Monitor executor key balance
- Have backup executor key ready
- Document executor rotation procedure

---

## General Troubleshooting Commands

### Backend Health Check

```bash
curl https://your-backend.com/health
```

### Check Backend Logs (Railway)

```bash
# Via Railway CLI or dashboard
railway logs
```

### Database Connection Test

```bash
cd backend
npx prisma db push --skip-generate
```

### RPC Connectivity Test

```bash
curl -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger","params":{}}'
```

### Check Stuck Subscriptions

```sql
SELECT id, "supporterAddress", "lastError", "nextChargeAt", "lastChargedAt"
FROM "Subscription"
WHERE active = true
AND next_charge_at <= NOW()
AND last_charged_at < NOW() - INTERVAL '1 hour';
```

### Check Recent Donation Events

```sql
SELECT * FROM "Donation"
ORDER BY "createdAt" DESC
LIMIT 10;
```

---

## Emergency Contacts

- **Infrastructure Issues**: Railway Support, Vercel Support
- **RPC Issues**: Stellar Foundation, RPC provider support
- **Contract Issues**: Development team
- **Database Issues**: Railway Support or DBA

---

## Related Documentation

- [Architecture](architecture.md) - System architecture overview
- [Database Backups](database-backups.md) - Backup and restore procedures
- [Testnet Reset Recovery](testnet-reset-runbook.md) - Redeploying contracts and recovering from a testnet wipe
- [Testnet Quickstart](testnet-quickstart.md) - Testnet wallet and asset setup guide
- [README](../README.md) - General project documentation

---

## Runbook Maintenance

This runbook should be updated:

- When new failure modes are discovered
- After major system changes
- After incident post-mortems
- When response procedures change

Last updated: 2025-01-XX
