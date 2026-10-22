import express from "express";
import cors from "cors";
import * as Sentry from "@sentry/node";
import authRouter from "./routes/auth";
import creatorsRouter from "./routes/creators";
import donationsRouter from "./routes/donations";
import withdrawalsRouter from "./routes/withdrawals";
import subscriptionsRouter from "./routes/subscriptions";
import goalsRouter from "./routes/goals";
import eventsRouter from "./routes/events";
import adminRouter from "./routes/admin";
import activityRouter from "./routes/activity";
import accountRouter from "./routes/account";
import emailWebhooksRouter from "./routes/emailWebhooks";
import seoRouter from "./routes/seo";
import emailPreviewRouter from "./routes/emailPreview";
import { errorHandler } from "./middleware/errorHandler";
import { requestLogger } from "./middleware/requestLogger";
import { checkSorobanRpc } from "./services/sorobanHealth";
import { executorHealth } from "./services/executorHealth";
import { eventListenerHealth } from "./services/eventListenerHealth";
import { networkReset } from "./services/networkReset";
import { getAllowedOrigins } from "./config";

const app = express();

/**
 * CORS is restricted to an explicit allowlist of frontend origins (#179).
 *
 * The default `cors()` reflects any request's Origin, which lets any
 * third-party page make authenticated API calls using a token held in
 * browser JS storage and read the responses back. Resolving the allowlist
 * per request (rather than once at import) keeps it configurable from the
 * environment without a code change, so preview and staging domains can be
 * added by configuration alone.
 *
 * A request with no Origin header (server-to-server calls, curl, health
 * probes) is allowed through: the browser always sends Origin on a
 * cross-origin request, so its absence cannot be attacker-controlled from
 * a page.
 */
const corsOptions: cors.CorsOptions = {
  origin(origin, callback) {
    // Same-origin and non-browser callers send no Origin header.
    if (!origin) return callback(null, true);

    const allowed = getAllowedOrigins();
    if (allowed.includes(origin.replace(/\/$/, ""))) {
      return callback(null, true);
    }
    // Returning an error rejects the request without echoing the
    // untrusted origin back in Access-Control-Allow-Origin.
    return callback(new Error(`Origin not allowed by CORS: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
};

// Initialize Sentry if DSN is configured
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
}

// Set TRUST_PROXY to the number of reverse-proxy hops in front of the API (e.g.
// 1 on Railway) so req.ip, and therefore the per-IP rate limits, reflects the
// real client instead of the proxy. Unset keeps Express's default.
if (process.env.TRUST_PROXY) {
  app.set("trust proxy", Number(process.env.TRUST_PROXY));
}

app.use(requestLogger);
app.use(cors(corsOptions));

// Mounted with express.raw() ahead of the global express.json() below: Svix
// signature verification (see routes/emailWebhooks.ts) needs the exact raw
// request body, not one that's already been parsed and would have to be
// re-serialized (and could byte-for-byte differ from what Resend signed).
app.use("/api/webhooks/email", express.raw({ type: "application/json" }), emailWebhooksRouter);

app.use(express.json());

// SEO routes (standard paths: /sitemap.xml, /robots.txt)
app.use("/", seoRouter);

app.get("/health", async (req, res) => {
  const sorobanRpc = await checkSorobanRpc();
  const subscriptionExecutor = executorHealth.getHealth();
  const eventListener = eventListenerHealth.getHealth();
  const network = networkReset.getState();
  // A detected testnet reset is the most severe state: the backend is running
  // against a chain that no longer matches its configuration, so report
  // unhealthy regardless of the other dependencies (#278). The runbook is in
  // docs/testnet-troubleshooting.md.
  //
  // A cursor-recovery gap (#268) is reported as "degraded" rather than
  // "unhealthy": it means a past window of events was permanently missed,
  // which an operator should see and investigate, but the listener itself
  // has already recovered and is polling normally again.
  const status =
    network.status === "reset_detected"
      ? "unhealthy"
      : subscriptionExecutor.status === "unhealthy"
        ? "unhealthy"
        : sorobanRpc.status !== "ok"
          ? "degraded"
          : eventListener.gapDetected
            ? "degraded"
            : "ok";
  return res.json({
    status,
    timestamp: new Date().toISOString(),
    network: network.status,
    dependencies: { sorobanRpc, subscriptionExecutor, eventListener, network },
  });
});

app.get("/health/executor", (req, res) => {
  const subscriptionExecutor = executorHealth.getHealth();
  return res.json({
    status: subscriptionExecutor.status === "unhealthy" ? "unhealthy" : "ok",
    timestamp: new Date().toISOString(),
    subscriptionExecutor,
  });
});

app.use("/api/auth", authRouter);
app.use("/api/creators", creatorsRouter);
app.use("/api/donations", donationsRouter);
app.use("/api/withdrawals", withdrawalsRouter);
app.use("/api/subscriptions", subscriptionsRouter);
app.use("/api/goals", goalsRouter);
app.use("/api/events", eventsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/activity", activityRouter);
app.use("/api/account", accountRouter);
// Email preview is a developer tool and should not be exposed in production (#272)
app.use("/api/email/preview", (req, res, next) => {
  if (process.env.NODE_ENV === "production" && process.env.EMAIL_PREVIEW_ENABLED !== "true") {
    return res.sendStatus(404);
  }
  return next();
}, emailPreviewRouter);
app.use("/api", seoRouter);

app.use((req, res) => {
  return res.status(404).json({
    error: "Not Found",
    code: "NOT_FOUND",
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
});

app.use(errorHandler);

export default app;
