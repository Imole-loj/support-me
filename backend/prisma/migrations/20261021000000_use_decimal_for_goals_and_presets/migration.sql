-- Monetary columns for Goal and Creator presetAmounts move from double precision (Float) to exact DECIMAL(20, 7) (#372).
-- Seven decimal places is Stellar's stroop precision, preventing binary floating point accumulation errors.
--
-- Backward compatible with existing rows: each value is cast through numeric
-- and rounded to 7 places.
--
-- AlterTable
ALTER TABLE "Creator" ALTER COLUMN "presetAmounts" DROP DEFAULT,
ALTER COLUMN "presetAmounts" SET DATA TYPE DECIMAL(20,7)[] USING "presetAmounts"::DECIMAL(20,7)[],
ALTER COLUMN "presetAmounts" SET DEFAULT ARRAY[]::DECIMAL(20,7)[];

-- AlterTable
ALTER TABLE "Goal" ALTER COLUMN "targetAmount" SET DATA TYPE DECIMAL(20,7) USING ROUND("targetAmount"::numeric, 7),
ALTER COLUMN "currentAmount" DROP DEFAULT,
ALTER COLUMN "currentAmount" SET DATA TYPE DECIMAL(20,7) USING ROUND("currentAmount"::numeric, 7),
ALTER COLUMN "currentAmount" SET DEFAULT 0;
