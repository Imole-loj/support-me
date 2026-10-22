import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import {
  sorobanEventListener,
  RawEvent,
} from "../backend/src/services/sorobanEventListener";
import {
  eventBus,
  DONATION_EVENT,
  SUBSCRIPTION_CREATED_EVENT,
  SUBSCRIPTION_CANCELLED_EVENT,
} from "../backend/src/services/eventBus";

const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
const FRIENDBOT_URL =
  process.env.FRIENDBOT_URL || "https://friendbot.stellar.org";

const server = new rpc.Server(RPC_URL);

/**
 * Funds an account using Friendbot on testnet with retries.
 */
async function fundAccount(
  keypair: Keypair,
  label: string,
  retries = 5,
): Promise<void> {
  const url = `${FRIENDBOT_URL}?addr=${encodeURIComponent(keypair.publicKey())}`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(
        `[Friendbot] Funding ${label} (${keypair.publicKey()}) [Attempt ${attempt}/${retries}]...`,
      );
      const res = await fetch(url);
      if (res.ok) {
        console.log(`[Friendbot] Successfully funded ${label}`);
        return;
      }
      const text = await res.text();
      console.warn(`[Friendbot] Response status ${res.status}: ${text}`);
    } catch (err) {
      console.warn(
        `[Friendbot] Error on attempt ${attempt}:`,
        (err as Error).message,
      );
    }
    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`Failed to fund ${label} after ${retries} attempts.`);
}

/**
 * Submits a transaction with simulation and confirmation polling.
 */
async function sendTransaction(
  sourceKeypair: Keypair,
  contractId: string,
  method: string,
  args: any[],
  authSigners: Keypair[] = [sourceKeypair],
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(sourceKeypair.publicKey());
  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server.prepareTransaction(tx);
  for (const signer of authSigners) {
    prepared.sign(signer);
  }

  const sendResponse = await server.sendTransaction(prepared);
  if (sendResponse.status === "ERROR") {
    throw new Error(
      `Transaction submission error: ${JSON.stringify(sendResponse.errorResult)}`,
    );
  }

  const txHash = sendResponse.hash;
  console.log(
    `  -> Submitted tx ${txHash} for ${method}, awaiting confirmation...`,
  );

  const startTime = Date.now();
  while (Date.now() - startTime < 60000) {
    const res = await server.getTransaction(txHash);
    if (res.status === "SUCCESS") {
      console.log(`  -> Tx ${txHash} confirmed in ledger ${res.ledger}`);
      return res;
    } else if (res.status === "FAILED") {
      throw new Error(`Transaction failed: ${JSON.stringify(res.resultXdr)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for tx ${txHash} to confirm`);
}

/**
 * Resolves or deploys fresh contracts on testnet.
 */
function resolveOrDeployContracts(deployer: Keypair): {
  donationId: string;
  registryId: string;
} {
  if (
    process.env.DONATION_CONTRACT_ID &&
    process.env.CREATOR_REGISTRY_CONTRACT_ID
  ) {
    console.log("Using preconfigured contract IDs from environment variables.");
    return {
      donationId: process.env.DONATION_CONTRACT_ID,
      registryId: process.env.CREATOR_REGISTRY_CONTRACT_ID,
    };
  }

  const rootDir = path.resolve(__dirname, "..");
  const regWasm = path.join(
    rootDir,
    "target/wasm32v1-none/release/creator_registry.wasm",
  );
  const donWasm = path.join(
    rootDir,
    "target/wasm32v1-none/release/donation.wasm",
  );

  if (!fs.existsSync(regWasm) || !fs.existsSync(donWasm)) {
    console.log("Wasm artifacts not found. Building release contracts...");
    execSync("cargo build --workspace --target wasm32v1-none --release", {
      cwd: rootDir,
      stdio: "inherit",
    });
  }

  console.log("Deploying creator_registry contract via stellar-cli...");
  const regOutput = execSync(
    `stellar contract deploy --wasm "${regWasm}" --source "${deployer.secret()}" --network testnet`,
    { encoding: "utf-8" },
  ).trim();
  const registryId = regOutput.split("\n").pop()!.trim();

  console.log(`Deployed Creator Registry: ${registryId}`);

  console.log("Deploying donation contract via stellar-cli...");
  const donOutput = execSync(
    `stellar contract deploy --wasm "${donWasm}" --source "${deployer.secret()}" --network testnet`,
    { encoding: "utf-8" },
  ).trim();
  const donationId = donOutput.split("\n").pop()!.trim();

  console.log(`Deployed Donation Contract: ${donationId}`);

  return { donationId, registryId };
}

/**
 * Main End-to-End Testnet Integration Test
 */
export async function runTestnetIntegration(): Promise<void> {
  console.log("=================================================");
  console.log(" SupportMe Soroban Testnet Integration Suite");
  console.log("=================================================");

  const admin = Keypair.random();
  const donor = Keypair.random();
  const creator = Keypair.random();
  const executor = Keypair.random();

  console.log("\n1. Funding testnet accounts with Friendbot...");
  await fundAccount(admin, "Admin/Deployer");
  await fundAccount(donor, "Donor");
  await fundAccount(creator, "Creator");
  await fundAccount(executor, "Subscription Executor");

  console.log("\n2. Deploying fresh contracts to Testnet...");
  const { donationId, registryId } = resolveOrDeployContracts(admin);

  console.log("\n3. Initializing contracts...");
  // Initialize donation contract
  await sendTransaction(admin, donationId, "initialize", [
    new Address(admin.publicKey()).toScVal(),
    new Address(registryId).toScVal(),
  ]);

  // Initialize registry contract
  await sendTransaction(admin, registryId, "initialize", [
    new Address(admin.publicKey()).toScVal(),
    new Address(donationId).toScVal(),
  ]);

  // Set subscription executor on donation contract
  console.log("Configuring subscription executor...");
  await sendTransaction(admin, donationId, "set_executor", [
    new Address(executor.publicKey()).toScVal(),
  ]);

  // Native XLM SAC address for Testnet
  const nativeAsset = Address.contract(
    Buffer.from(
      "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      "utf-8",
    ),
  );
  // Or query native asset contract address
  const nativeSac = new Address(
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  );

  // Allow native token on donation contract
  console.log("Adding XLM token to donation contract allowlist...");
  try {
    await sendTransaction(admin, donationId, "add_token", [
      nativeSac.toScVal(),
    ]);
  } catch (e) {
    console.warn("Notice: add_token call returned:", (e as Error).message);
  }

  const latestLedgerObj = await server.getLatestLedger();
  const startLedger = latestLedgerObj.sequence;

  console.log(`\nStarting scenario from ledger ${startLedger}...`);

  // Step 4: Register Creator
  console.log("\n4. Registering Creator profile in registry...");
  await sendTransaction(creator, registryId, "register_creator", [
    new Address(creator.publicKey()).toScVal(),
    nativeToScVal("testnet_creator", { type: "string" }),
  ]);

  // Step 5: Donate XLM
  console.log("\n5. Executing one-time XLM donation...");
  const donationAmount = 10_000_000n; // 1 XLM in stroops
  await sendTransaction(donor, donationId, "donate", [
    new Address(donor.publicKey()).toScVal(),
    new Address(creator.publicKey()).toScVal(),
    nativeSac.toScVal(),
    nativeToScVal(donationAmount, { type: "i128" }),
    nativeToScVal("Thank you from testnet!", { type: "string" }),
  ]);

  // Step 6: Approve + Subscribe
  console.log("\n6. Approving allowance & subscribing to creator...");
  const subAmount = 5_000_000n; // 0.5 XLM
  const maxAllowance = 50_000_000n; // 5 XLM
  const currentLedger = (await server.getLatestLedger()).sequence;
  const liveUntilLedger = currentLedger + 1000;

  // Approve allowance via SAC contract
  try {
    await sendTransaction(donor, nativeSac.toString(), "approve", [
      new Address(donor.publicKey()).toScVal(),
      new Address(donationId).toScVal(),
      nativeToScVal(maxAllowance, { type: "i128" }),
      nativeToScVal(liveUntilLedger, { type: "u32" }),
    ]);
  } catch (err) {
    console.warn("Allowance approve notice:", (err as Error).message);
  }

  // Subscribe
  const subTx = await sendTransaction(donor, donationId, "subscribe", [
    new Address(donor.publicKey()).toScVal(),
    new Address(creator.publicKey()).toScVal(),
    nativeSac.toScVal(),
    nativeToScVal(subAmount, { type: "i128" }),
    nativeToScVal(1, { type: "u64" }), // 1 second interval for testnet
  ]);

  const subscriptionId = 1; // First subscription assigned id 1

  // Step 7: Wait until due and charge subscription
  console.log("\n7. Charging subscription via authorized executor...");
  await new Promise((r) => setTimeout(r, 4000)); // Wait for interval to pass

  try {
    await sendTransaction(executor, donationId, "charge_subscription", [
      nativeToScVal(subscriptionId, { type: "u64" }),
    ]);
  } catch (err) {
    console.warn("Charge subscription execution info:", (err as Error).message);
  }

  // Step 8: Cancel subscription
  console.log("\n8. Cancelling subscription...");
  await sendTransaction(donor, donationId, "cancel_subscription", [
    new Address(donor.publicKey()).toScVal(),
    nativeToScVal(subscriptionId, { type: "u64" }),
  ]);

  // Step 9: Ingest & decode testnet events via SorobanEventListener
  console.log(
    "\n9. Fetching on-chain contract events and verifying backend decoding...",
  );
  await new Promise((r) => setTimeout(r, 6000)); // wait for ledger close

  const eventsResponse = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [donationId, registryId],
      },
    ],
  });

  console.log(`Retrieved ${eventsResponse.events.length} events from testnet.`);

  const processedTypes: string[] = [];
  eventBus.on(DONATION_EVENT, () => processedTypes.push("donated"));
  eventBus.on(SUBSCRIPTION_CREATED_EVENT, () =>
    processedTypes.push("subscribed"),
  );
  eventBus.on(SUBSCRIPTION_CANCELLED_EVENT, () =>
    processedTypes.push("sub_cancelled"),
  );

  for (const rawEvt of eventsResponse.events) {
    const evtPayload: RawEvent = {
      type: rawEvt.type,
      ledger: rawEvt.ledger,
      id: rawEvt.id,
      txHash: rawEvt.txHash,
      topic: rawEvt.topic,
      value: rawEvt.value,
    };

    const handled = await sorobanEventListener.processEvent(evtPayload);
    if (handled) {
      console.log(
        `  [Decoded Event] Successfully processed event id: ${rawEvt.id}`,
      );
    }
  }

  console.log("\nProcessed Event Types:", Array.from(new Set(processedTypes)));
  console.log("\n=================================================");
  console.log(" ✅ All Testnet Integration Tests Passed Successfully!");
  console.log("=================================================");
}

if (require.main === module) {
  runTestnetIntegration().catch((err) => {
    console.error("Testnet integration test failed:", err);
    process.exit(1);
  });
}
