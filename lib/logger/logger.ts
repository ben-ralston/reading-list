/**
 * Zero-dependency Node client for the log service (Cloudflare Worker + D1).
 * Canonical home: a separate logger repository (clients/ts/logger.ts) —
 * vendored (copied) into consuming repos; edit the canonical copy first.
 *
 * log() NEVER rejects and is best-effort: a logger outage must not break the
 * caller. Resolves true when delivered, false when queued locally.
 *
 * Env seams: LOGGER_TOKEN (write token — takes precedence over the token
 * file; the serverless path), LOGGER_URL, LOGGER_TOKEN_FILE,
 * LOGGER_QUEUE_FILE, LOGGER_LOCK_STALE_MS, LOGGER_LOCK_RETRY_MS,
 * LOGGER_COOLDOWN_MS.
 */
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type Level = "debug" | "info" | "warn" | "error" | "alert";

const DEFAULT_URL = "https://logger.example.workers.dev";
const MAX_MESSAGE_LEN = 8192;
const MAX_JSON_EXTRA_LEN = 16384; // serialized chars
const MAX_SOURCE_LEN = 128;
// The server rejects an empty message; a placeholder keeps the event.
const EMPTY_MESSAGE = "(empty message)";
// An oversized json_extra is replaced by a marker carrying this much of its
// serialized form. Escaping at most doubles it, so the marker always fits.
const JSON_EXTRA_PREVIEW_LEN = 4096;
// Cloudflare's Browser Integrity Check bans default library UAs at the edge
// (error 1010 -> 403) before the Worker runs; any custom UA passes.
const USER_AGENT = "claude-logger/1.0";
const TIMEOUT_MS = 3000;
const BATCH_MAX = 100; // server rejects arrays >100
// Replay work per call is capped so a caller's stall stays bounded — at
// worst (MAX_CHUNKS_PER_CALL + MAX_SPLITS_PER_CALL) x TIMEOUT_MS; the
// remaining backlog persists and drains over subsequent calls.
const MAX_CHUNKS_PER_CALL = 5;
// Chunk halvings (413 / unattributed reject) allowed per call: enough to
// isolate one offender in a full chunk, ceil(log2(BATCH_MAX)).
const MAX_SPLITS_PER_CALL = 7;
// A persistent failure that classifies as transient (e.g. a revoked token's
// 401) must not grow the queue — and each call's full re-read — forever:
// a call ending in such a failure quarantines the oldest overflow past this.
const MAX_QUEUE_EVENTS = 2000;

function serviceUrl(): string {
  return (process.env.LOGGER_URL ?? DEFAULT_URL).replace(/\/+$/, "");
}

function tokenFile(): string {
  return (
    process.env.LOGGER_TOKEN_FILE ??
    path.join(os.homedir(), ".config", "reading-list", "logger-write.token")
  );
}

/** Write token: LOGGER_TOKEN env (serverless — no filesystem needed) wins
 * over the token file. Blank env values fall back to the file. */
async function resolveToken(): Promise<string | null> {
  const envToken = process.env.LOGGER_TOKEN?.trim();
  if (envToken) return envToken;
  try {
    // The path is runtime-built, so Next.js's Turbopack file tracing can't
    // scope it and would trace the consumer's whole project into every
    // server function importing this shim. The comment opts this call out.
    return (
      await readFile(/* turbopackIgnore: true */ tokenFile(), "utf8")
    ).trim();
  } catch {
    return null;
  }
}

function queueFile(): string {
  return (
    process.env.LOGGER_QUEUE_FILE ??
    path.join(os.homedir(), ".local", "state", "reading-list", "logger-queue.jsonl")
  );
}

/** Clip to max UTF-16 code units (the server's measure) without ending on
 * the high half of a surrogate pair, which would store as garbage. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

function lockStaleMs(): number {
  return Number(process.env.LOGGER_LOCK_STALE_MS ?? 30_000);
}

function lockRetryMs(): number {
  return Number(process.env.LOGGER_LOCK_RETRY_MS ?? 5_000);
}

function cooldownMs(): number {
  return Number(process.env.LOGGER_COOLDOWN_MS ?? 60_000);
}

// In-process failure cooldown: after a transient failure, calls within the
// window send only their own event, skipping the backlog read and replay.
let lastTransientAt = Number.NEGATIVE_INFINITY;
// Cooldown appends since the last full-path call; at MAX_QUEUE_EVENTS the
// next call takes the full path so the queue cap still applies.
let cooldownAppends = 0;

function inCooldown(): boolean {
  return Date.now() - lastTransientAt < cooldownMs();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exclusive-create lockfile with stale takeover. Unlike Python's blocking
 * flock, acquisition is bounded: null means "still contended after the
 * retry budget" and the caller must fall back to the spill sidecar. The
 * returned token identifies our lockfile so release only unlinks a lock we
 * still own — narrowing (not eliminating: read-then-unlink can't be atomic
 * by path) the window where release could remove a stale-steal replacement. */
async function acquireLock(lockPath: string): Promise<string | null> {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const deadline = Date.now() + lockRetryMs();
  for (;;) {
    try {
      await writeFile(lockPath, token, { flag: "wx" });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        // The exclusive create may have made the file before failing to
        // write it (e.g. ENOSPC): clear any such orphan or an empty
        // lockfile would lock everyone out until the stale window.
        await unlink(lockPath).catch(() => {});
      } else {
        try {
          const info = await stat(lockPath);
          if (Date.now() - info.mtimeMs > lockStaleMs()) {
            // Holder likely crashed; steal and retry immediately. (A racing
            // steal is tolerable — worst case two drains overlap once.)
            await unlink(lockPath);
            continue;
          }
        } catch {
          // lock vanished between open and stat, or is unreadable, or the
          // stale unlink failed — fall through to the bounded retry
        }
      }
      // Deadline is checked on every non-steal iteration: a persistent
      // failure must return null, never spin forever.
      if (Date.now() >= deadline) return null;
      await sleep(50);
    }
  }
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) === token) {
      await unlink(lockPath);
    }
  } catch {
    // Lock already gone (stale steal) — nothing to release.
  }
}

/** Park permanently-undeliverable material in a .rejected sidecar.
 * Nothing is silently dropped: corrupt queue lines and server-rejected
 * chunks land here for manual recovery instead of wedging or vanishing. */
async function quarantine(
  file: string,
  lines: string[],
  reason: string,
): Promise<void> {
  const sidecar = `${file}.rejected`;
  await appendFile(
    sidecar,
    lines.map((line) => line.replace(/\n+$/, "") + "\n").join(""),
  );
  process.stderr.write(
    `logger: ${lines.length} event(s) quarantined to ${sidecar} (${reason})\n`,
  );
}

async function drainSpillFile(file: string, merging: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(merging, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error; // unreadable: leave it for a later merge, never unlink
  }
  if (text !== "") {
    await appendFile(file, text.endsWith("\n") ? text : `${text}\n`);
  }
  // Reached only after the append landed — a failure above keeps the file.
  await unlink(merging).catch(() => {});
}

/** Fold lock-free spill appends into the main queue. Only ever called while
 * holding the lock, so the main queue file keeps a single writer class and
 * its rewrites can never clobber a contended process's append. Throws on
 * non-ENOENT trouble — spill files are then left in place for a later call.
 * Residual race: a contended appendFile that resolved the spill's inode
 * before our rename loses its write if it lands after our read — a
 * microseconds window, vs. the seconds-long clobber window this replaces. */
async function mergeSpill(file: string): Promise<void> {
  const merging = `${file}.spill.merging`;
  await drainSpillFile(file, merging); // crash leftover from a prior merge
  try {
    await rename(`${file}.spill`, merging);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // no spill
    throw error;
  }
  await drainSpillFile(file, merging);
}

async function readQueue(file: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    // Only "no queue yet" may read as empty. An existing-but-unreadable
    // queue must NOT: delivery would end in writeQueue([]) unlinking it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: Record<string, unknown>[] = [];
  const corrupt: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      corrupt.push(trimmed);
    }
  }
  if (corrupt.length > 0) {
    // Rewrite immediately (caller holds the lock) so a corrupt line is
    // quarantined exactly once — the append-only failure paths would
    // otherwise leave it in place and re-quarantine it every call.
    await quarantine(file, corrupt, "corrupt queue line");
    await writeQueue(file, events);
  }
  return events;
}

/** Atomic rewrite (temp file + rename): a crash mid-write must never
 * destroy the queued events the old file held. */
async function writeQueue(
  file: string,
  events: Record<string, unknown>[],
): Promise<void> {
  if (events.length === 0) {
    await unlink(file).catch(() => {});
    return;
  }
  const tmp = `${file}.tmp`;
  await writeFile(tmp, events.map((e) => JSON.stringify(e) + "\n").join(""));
  await rename(tmp, file);
}

async function appendQueue(
  file: string,
  event: Record<string, unknown>,
): Promise<void> {
  await appendFile(file, JSON.stringify(event) + "\n");
}

function rejectReason(status: "rejected" | "too_large"): string {
  return status === "too_large"
    ? "server rejected event as too large"
    : "server rejected event as malformed";
}

/** Cooldown path: a recent transient failure is likely still in force, so
 * skip the backlog read and replay (the per-call cost a persistent failure
 * would otherwise grow without bound) but still try this call's event. */
async function deliverAlone(
  file: string,
  event: Record<string, unknown>,
): Promise<boolean> {
  const token = await resolveToken();
  const result: PostResult =
    token === null ? { status: "transient" } : await postEvents([event], token);
  if (result.status === "transient") {
    lastTransientAt = Date.now();
    cooldownAppends += 1;
    await appendQueue(file, event);
    return false;
  }
  // Any non-transient answer proves the server is reachable: the next call
  // replays the backlog.
  lastTransientAt = Number.NEGATIVE_INFINITY;
  if (result.status === "ok") return true;
  await quarantine(file, [JSON.stringify(event)], rejectReason(result.status));
  return false;
}

async function deliverOrQueue(
  file: string,
  event: Record<string, unknown>,
  lockPath: string,
): Promise<boolean> {
  if (inCooldown() && cooldownAppends < MAX_QUEUE_EVENTS) {
    return deliverAlone(file, event);
  }
  cooldownAppends = 0;
  // A failed merge leaves the spill files in place for the next holder —
  // it must never take this call's event down with it.
  await mergeSpill(file).catch(() => {});
  let queued: Record<string, unknown>[];
  try {
    queued = await readQueue(file);
  } catch {
    // Queue exists but can't be read: preserve it, and park the new event
    // in the spill sidecar — a path that doesn't depend on the broken file.
    await appendQueue(`${file}.spill`, event);
    return false;
  }
  const pending = [...queued, event];
  // Until the first rewrite the on-disk queue holds exactly `queued`, so a
  // failure only needs to append the new event.
  let persisted = false;
  /** Persist `rest` (the unsent tail) after a transient failure. The queue
   * cap applies only here: overflow a healthy server could still take is
   * never quarantined ahead of a delivery attempt. */
  const failTransient = async (
    rest: Record<string, unknown>[],
  ): Promise<boolean> => {
    lastTransientAt = Date.now();
    if (rest.length > MAX_QUEUE_EVENTS) {
      const overflow = rest.length - MAX_QUEUE_EVENTS;
      await quarantine(
        file,
        rest.slice(0, overflow).map((e) => JSON.stringify(e)),
        `queue cap of ${MAX_QUEUE_EVENTS} events exceeded`,
      );
      await writeQueue(file, rest.slice(overflow));
    } else if (!persisted) {
      await appendQueue(file, event);
    }
    // else: the last rewrite already persisted `rest`
    return false;
  };
  const token = await resolveToken();
  if (token === null) return failTransient(pending);

  let eventAccepted = false;
  let index = 0;
  let chunksSent = 0;
  // A 413 or an unattributed reject halves the chunk; isolating an offender
  // resets it to full size. Halvings have their own per-call budget instead
  // of counting against MAX_CHUNKS_PER_CALL, so every call makes progress
  // (delivers a sub-chunk or isolates an offender) — even a
  // one-call-per-process client never wedges behind an offender.
  let size = BATCH_MAX;
  let splits = 0;
  while (index < pending.length) {
    // Keep the lock fresh across a long drain (see MAX_CHUNKS_PER_CALL) so
    // another process's stale-steal can't fire against a live holder.
    const now = new Date();
    await utimes(lockPath, now, now).catch(() => {});
    if (chunksSent >= MAX_CHUNKS_PER_CALL) {
      await writeQueue(file, pending.slice(index));
      return eventAccepted;
    }
    const chunk = pending.slice(index, index + size);
    const result = await postEvents(chunk, token);
    if (result.status === "transient") {
      return failTransient(pending.slice(index));
    }
    if (result.status === "ok") {
      if (chunk.includes(event)) eventAccepted = true;
      index += chunk.length;
    } else {
      const offender =
        chunk.length === 1
          ? 0
          : result.status === "rejected" &&
              result.item !== undefined &&
              result.item < chunk.length
            ? result.item
            : null;
      if (offender === null) {
        if (splits >= MAX_SPLITS_PER_CALL) {
          // Budget spent: the next call isolates the next offender.
          await writeQueue(file, pending.slice(index));
          return eventAccepted;
        }
        splits += 1;
        size = Math.ceil(chunk.length / 2);
        continue;
      }
      // Only the offender leaves the queue: the server writes nothing from
      // a rejected batch, so the rest of the chunk is retried.
      await quarantine(
        file,
        [JSON.stringify(chunk[offender])],
        rejectReason(result.status),
      );
      pending.splice(index + offender, 1);
      size = BATCH_MAX;
    }
    chunksSent += 1;
    await writeQueue(file, pending.slice(index));
    persisted = true;
  }
  return eventAccepted;
}

/** Repair a json_extra the server would reject (it must round-trip as an
 * object/array of at most MAX_JSON_EXTRA_LEN serialized chars) instead of
 * letting it quarantine the whole event. Returns the parsed snapshot, so
 * what's validated here is exactly what's sent. */
function repairJsonExtra(jsonExtra: unknown): unknown {
  let serialized: string | undefined;
  try {
    // JSON.stringify returns undefined (without throwing) for functions
    // and symbols; both cases must not lose the event itself.
    serialized = JSON.stringify(jsonExtra);
  } catch {
    serialized = undefined;
  }
  if (serialized === undefined) {
    return { unserializable: String(jsonExtra).slice(0, 1000) };
  }
  // Checked on the serialized form: a toJSON (e.g. a Date's) can turn an
  // object into a scalar on the wire.
  if (!serialized.startsWith("{") && !serialized.startsWith("[")) {
    serialized = JSON.stringify({ value: JSON.parse(serialized) });
  }
  if (serialized.length > MAX_JSON_EXTRA_LEN) {
    return {
      truncated: true,
      original_length: serialized.length,
      preview: clip(serialized, JSON_EXTRA_PREVIEW_LEN),
    };
  }
  return JSON.parse(serialized);
}

function buildEvent(
  app: string,
  level: Level,
  message: string,
  jsonExtra: unknown,
  source: string | undefined,
): Record<string, unknown> {
  const text = clip(String(message), MAX_MESSAGE_LEN);
  const event: Record<string, unknown> = {
    app,
    level,
    message: text === "" ? EMPTY_MESSAGE : text,
    ts: new Date().toISOString(),
    source: clip(String(source ?? os.hostname()), MAX_SOURCE_LEN),
  };
  if (jsonExtra !== undefined && jsonExtra !== null) {
    event.json_extra = repairJsonExtra(jsonExtra);
  }
  return event;
}

type PostResult =
  | { status: "ok" | "transient" | "too_large" }
  // item: the batch index the server's error names, when it names one
  | { status: "rejected"; item?: number };

async function postEvents(
  events: object[],
  token: string,
): Promise<PostResult> {
  let body: string;
  try {
    body = JSON.stringify(events);
  } catch {
    return { status: "rejected" };
  }
  try {
    const response = await fetch(serviceUrl() + "/log", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await response.text().catch(() => "");
    if (response.ok) return { status: "ok" };
    // Validation-class codes mean the PAYLOAD can never deliver. Auth
    // (401/403) and everything else may heal — those stay queued.
    if (response.status === 400 || response.status === 422) {
      return { status: "rejected", item: rejectedItem(text) };
    }
    if (response.status === 413) return { status: "too_large" };
    return { status: "transient" };
  } catch {
    return { status: "transient" };
  }
}

/** The failing index from a batch error body ({"error": "item N: ..."}). */
function rejectedItem(text: string): number | undefined {
  try {
    const match = /^item (\d+): /.exec(String(JSON.parse(text).error));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

let chain: Promise<unknown> = Promise.resolve();

export async function log(
  app: string,
  level: Level,
  message: string,
  opts: { jsonExtra?: object | unknown[]; source?: string } = {},
): Promise<boolean> {
  // Build eagerly so ts records call time, not the serialized chain's drain
  // time (the Python client builds before its flock wait for the same reason).
  let event: Record<string, unknown>;
  try {
    event = buildEvent(app, level, message, opts.jsonExtra, opts.source);
  } catch {
    return false;
  }
  const run = chain.then(() => logOnce(event)).catch(() => false);
  chain = run;
  return run;
}

async function logOnce(event: Record<string, unknown>): Promise<boolean> {
  try {
    const file = queueFile();
    await mkdir(path.dirname(file), { recursive: true });
    const lockPath = `${file}.lock`;
    const token = await acquireLock(lockPath);
    if (token === null) {
      // Contended: spill to a sidecar only lock-holders merge. Appending to
      // the main queue here would race the holder's whole-file rewrites.
      await appendQueue(`${file}.spill`, event);
      return false;
    }
    try {
      return await deliverOrQueue(file, event, lockPath);
    } finally {
      await releaseLock(lockPath, token);
    }
  } catch {
    return false;
  }
}
