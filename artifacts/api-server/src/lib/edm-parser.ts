import { promises as fs, createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { decodeWindows1251 } from "./edm-reader";

export interface EdmHeader {
  magic: string;
  version: number;
  /** Byte size of the strings blob (v10) — header field at offset 5. */
  stringBlobSize: number;
  /** Number of distinct strings in the table (after splitting blob by NUL). */
  stringCount: number;
  /** File offset where the body starts (right after the strings blob). */
  stringTableEnd: number;
  fileSize: number;
}

export interface EdmStringTable {
  /** Byte size of the strings blob. */
  stringBlobSize: number;
  /** Number of distinct strings produced by splitting the blob. */
  count: number;
  /** File offset right after the strings blob (= start of body). */
  endOffset: number;
  strings: string[];
}

export interface EdmFileInfo {
  filePath: string;
  fileName: string;
  fileSize: number;
  modifiedAt: string;
  /** "sample" = bundled in attached_assets/, "upload" = uploaded by user. */
  source?: "sample" | "upload";
}

const ATTACHED_DIR = path.resolve(
  process.cwd(),
  "..",
  "..",
  "attached_assets",
);

/**
 * User uploads land here. Kept separate from `attached_assets/` so the agent
 * never overwrites curated samples. Created lazily on first upload.
 */
const UPLOADS_DIR = path.resolve(
  process.cwd(),
  "..",
  "..",
  "data",
  "edm-uploads",
);

const SAMPLE_FILE = "Tarantul_Corvette_1777211022937.EDM";

export function getSampleFilePath(): string {
  return path.join(ATTACHED_DIR, SAMPLE_FILE);
}

export function getUploadsDir(): string {
  return UPLOADS_DIR;
}

export async function ensureUploadsDir(): Promise<void> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

/**
 * Temporary chunk storage for chunked uploads. Each active upload gets its
 * own sub-directory named after the upload ID.
 */
const CHUNKS_DIR = path.resolve(
  process.cwd(),
  "..",
  "..",
  "data",
  "edm-chunks",
);

export function getChunksDir(): string {
  return CHUNKS_DIR;
}

export async function ensureChunksDir(): Promise<void> {
  await fs.mkdir(CHUNKS_DIR, { recursive: true });
}

/**
 * Remove any stray `*.part-…` temp files left behind when an upload was
 * aborted (browser closed, server killed mid-stream). Also removes chunk
 * directories older than 2 hours. Safe to call at boot.
 */
export async function cleanupStaleUploads(): Promise<void> {
  // Clean up stray .part files
  let entries;
  try {
    entries = await fs.readdir(UPLOADS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  await Promise.all(
    entries
      .filter((n) => /\.part-\d+-\d+$/.test(n))
      .map((n) => fs.unlink(path.join(UPLOADS_DIR, n)).catch(() => {})),
  );

  // Clean up stale chunk directories older than 2 hours
  let chunkEntries;
  try {
    chunkEntries = await fs.readdir(CHUNKS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    return;
  }
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  await Promise.all(
    chunkEntries.map(async (name) => {
      const dir = path.join(CHUNKS_DIR, name);
      try {
        const st = await fs.stat(dir);
        if (st.mtimeMs < cutoff)
          await fs.rm(dir, { recursive: true }).catch(() => {});
      } catch {
        // ignore
      }
    }),
  );
}

async function listDir(
  dir: string,
  source: "sample" | "upload",
): Promise<EdmFileInfo[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: EdmFileInfo[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.toLowerCase().endsWith(".edm")) continue;
    const full = path.join(dir, e.name);
    const st = await stat(full);
    out.push({
      filePath: full,
      fileName: e.name,
      fileSize: st.size,
      modifiedAt: st.mtime.toISOString(),
      source,
    });
  }
  return out;
}

export async function listEdmFiles(): Promise<EdmFileInfo[]> {
  const uploads = await listDir(UPLOADS_DIR, "upload");
  uploads.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return uploads;
}

/**
 * Resolve a user-supplied file name to an on-disk path. We look in the
 * uploads dir first so a user can override a sample by uploading a file with
 * the same name. Path traversal is blocked via `path.basename`.
 */
export function resolveEdmPath(name: string): string {
  const safe = path.basename(name);
  // node fs.statSync would be cleaner, but keeping this synchronous since the
  // caller already does the existence check via getParsed/listEdmFiles.
  // Prefer uploads dir when both contain the same name.
  const fromUploads = path.join(UPLOADS_DIR, safe);
  const fromAttached = path.join(ATTACHED_DIR, safe);
  if (existsSync(fromUploads)) return fromUploads;
  return fromAttached;
}

/**
 * Sanitise a file name supplied by a browser upload header — strips path
 * separators and forces a `.edm` extension so the file appears in
 * `listEdmFiles()`.
 */
export function sanitiseUploadName(raw: string): string {
  let name = path.basename(raw).trim();
  if (!name) name = `upload-${Date.now()}.edm`;
  // Remove characters illegal on Windows / awkward in shells.
  name = name.replace(/[<>:"|?*\x00-\x1f]/g, "_");
  if (!/\.edm$/i.test(name)) name += ".edm";
  return name;
}

async function readRange(
  filePath: string,
  start: number,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = createReadStream(filePath, {
      start,
      end: start + length - 1,
    });
    stream.on("data", (c: Buffer | string) => {
      chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/**
 * EDM v10 header layout (corrected — matches io_EDM v0.2.0 reference):
 *   - bytes 0..2   : "EDM" magic
 *   - bytes 3..4   : uint16 LE version (= 8 or 10)
 *   - bytes 5..8   : uint32 LE STRINGS-BLOB BYTE SIZE (NOT a string count!)
 *   - bytes 9..(9+blobSize-1) : null-separated strings (windows-1251)
 *
 * Important: byte 5 was historically misread as "string count". It is the
 * length-in-bytes of the strings blob. For Tarantul_Corvette this is 1002
 * bytes producing 67 strings, not 1002 strings.
 */
export async function readHeader(filePath: string): Promise<EdmHeader> {
  const st = await stat(filePath);
  // Read at most 2 MB to cover the strings blob; the v10 sample uses ~1 KB.
  const headSize = Math.min(st.size, 2 * 1024 * 1024);
  const head = await readRange(filePath, 0, headSize);

  const magic = head.slice(0, 3).toString("ascii");
  if (magic !== "EDM") {
    throw new Error(`Not an EDM file (magic="${magic}")`);
  }
  const version = head.readUInt16LE(3);
  if (version !== 8 && version !== 10) {
    throw new Error(`Unsupported EDM version ${version}`);
  }

  const stringBlobSize = head.readUInt32LE(5);
  const blobStart = 9;
  const blobEnd = blobStart + stringBlobSize;
  if (blobEnd > head.length) {
    throw new Error(
      `Strings blob (${stringBlobSize} bytes) extends past read window`,
    );
  }
  // Count strings by scanning for null terminators in the blob.
  let stringCount = 0;
  for (let i = blobStart; i < blobEnd; i++) {
    if (head[i] === 0) stringCount++;
  }
  // The trailing slice after the last NUL also counts as a (final) entry,
  // matching Python's bytes.split(b"\x00") behavior.
  if (head[blobEnd - 1] !== 0) stringCount++;

  return {
    magic,
    version,
    stringBlobSize,
    stringCount,
    stringTableEnd: blobEnd,
    fileSize: st.size,
  };
}

export async function readStringTable(
  filePath: string,
): Promise<EdmStringTable> {
  const st = await stat(filePath);
  const headSize = Math.min(st.size, 2 * 1024 * 1024);
  const head = await readRange(filePath, 0, headSize);

  const stringBlobSize = head.readUInt32LE(5);
  const blobStart = 9;
  const blobEnd = blobStart + stringBlobSize;
  const blob = head.slice(blobStart, blobEnd);
  // Python: reader.read(stringsize).split(bytes(1))
  const decoded = decodeWindows1251(blob);
  const strings = decoded.split("\0");
  return {
    stringBlobSize,
    count: strings.length,
    endOffset: blobEnd,
    strings,
  };
}

export interface HexChunk {
  offset: number;
  length: number;
  fileSize: number;
  hex: string; // lowercase hex string, no spaces
  ascii: string; // printable ASCII or "."
}

export async function readHexChunk(
  filePath: string,
  offset: number,
  length: number,
): Promise<HexChunk> {
  const st = await stat(filePath);
  if (offset < 0 || offset >= st.size) {
    throw new Error(`offset ${offset} out of range (file size ${st.size})`);
  }
  const safeLen = Math.min(length, 16 * 1024, st.size - offset);
  const buf = await readRange(filePath, offset, safeLen);

  let ascii = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
  }
  return {
    offset,
    length: buf.length,
    fileSize: st.size,
    hex: buf.toString("hex"),
    ascii,
  };
}

export interface StringIndexUsage {
  index: number;
  value: string;
  references: number;
}

/**
 * Heuristic scan: after the string table, EDM v10 references strings by
 * 32-bit little-endian indices. Scan the rest of the file in 4-byte windows
 * and count plausible references (index < stringCount). This gives a quick
 * "popularity" view of the string table.
 */
export async function scanStringReferences(
  filePath: string,
): Promise<StringIndexUsage[]> {
  const header = await readHeader(filePath);
  const strings = (await readStringTable(filePath)).strings;
  const counts = new Uint32Array(header.stringCount);

  const start = header.stringTableEnd;
  const total = header.fileSize - start;
  const stream = createReadStream(filePath, { start });

  // Buffer to handle 4-byte window across chunks.
  let leftover = Buffer.alloc(0);
  let scanned = 0;
  // Cap scan to first ~16 MB after the string table for speed.
  const MAX_SCAN = 16 * 1024 * 1024;

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (c: Buffer | string) => {
      const chunk = typeof c === "string" ? Buffer.from(c) : c;
      const merged = leftover.length
        ? Buffer.concat([leftover, chunk])
        : chunk;
      const usable = merged.length - 3; // need 4 bytes per read
      let i = 0;
      for (; i < usable; i++) {
        const v = merged.readUInt32LE(i);
        if (v < header.stringCount) {
          counts[v]! += 1;
        }
      }
      leftover = merged.slice(i);
      scanned += chunk.length;
      if (scanned >= Math.min(total, MAX_SCAN)) {
        stream.destroy();
        resolve();
      }
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
    stream.on("close", () => resolve());
  });

  const out: StringIndexUsage[] = [];
  for (let i = 0; i < counts.length; i++) {
    out.push({ index: i, value: strings[i] ?? "", references: counts[i]! });
  }
  return out;
}
