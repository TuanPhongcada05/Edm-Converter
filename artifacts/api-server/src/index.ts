import app from "./app";
import { logger } from "./lib/logger";
import { cleanupStaleUploads } from "./lib/edm-parser";

// Best-effort cleanup of incomplete uploads from a previous run. Failures
// here are non-fatal — they just mean the dir might have stale .part files.
cleanupStaleUploads().catch((err) => {
  logger.warn({ err }, "Failed to clean up stale upload temp files");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
