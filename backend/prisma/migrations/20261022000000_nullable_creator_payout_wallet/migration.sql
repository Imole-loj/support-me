-- Profiles created before a payout wallet is connected remain accessible by
-- username, but must not be treated as payable creators in discovery.
ALTER TABLE "Creator" ALTER COLUMN "walletAddress" DROP NOT NULL;
UPDATE "Creator" SET "walletAddress" = NULL WHERE "walletAddress" = '';
ALTER TABLE "Creator" ADD CONSTRAINT "Creator_walletAddress_not_empty"
  CHECK ("walletAddress" IS NULL OR "walletAddress" <> '');
-- Keep the existing partial unique index: it also excludes NULL values.
