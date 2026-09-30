import { Router, type IRouter } from "express";
import { promises as fs, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import express from "express";
import {
  ensureUploadsDir,
  ensureChunksDir,
  getChunksDir,
  getSampleFilePath,
  getUploadsDir,
  listEdmFiles,
  readHeader,
  readHexChunk,
  readStringTable,
  resolveEdmPath,
  sanitiseUploadName,
  scanStringReferences,
} from "../lib/edm-parser";
import { parseEdm } from "../lib/edm-body";
import { exportObj, exportObjSplit, exportGlb, exportFbxBinary } from "../lib/edm-export";
import { ensureSimplifierReady, clampRatio } from "../lib/decimate";
import { zipSync, strToU8 } from "fflate";
import path from "node:path";

const router: IRouter = Router();

/**
 * Parsed-body cache: parsing the 92 MB sample takes a few seconds, but the
 * file content is immutable once on disk. Cache by (path, mtimeMs, size).
 */
type CachedParse = {
  key: string;
  parsed: ReturnType<typeof parseEdm>;
};
let bodyCache: CachedParse | null = null;

async function getParsed(filePath: string): Promise<CachedParse["parsed"]> {
  const st = await fs.stat(filePath);
  const key = `${filePath}::${st.mtimeMs}::${st.size}`;
  if (bodyCache && bodyCache.key === key) return bodyCache.parsed;
  const buf = await fs.readFile(filePath);
  const parsed = parseEdm(buf);
  bodyCache = { key, parsed };
  // Note: export cache entries are keyed per-file with their own stat-based
  // key, so we don't need to clear them here — they'll self-invalidate when
  // the same file's mtime/size changes.
  return parsed;
}

/**
 * Export-result cache: building the OBJ/FBX for the 92 MB sample takes
 * 5–40 seconds, but produces deterministic bytes for a given source file.
 * Memoise per (file, format) using a stat-based key so different files never
 * collide.
 */
type ExportFormat = "obj" | "mtl" | "glb" | "fbx";
type ExportEntry = { key: string; data: Buffer };
// Cache slot is keyed by (format, filePath, ratio) so each decimation level
// is memoised independently — re-downloading the same ratio is instant.
const exportCache = new Map<string, ExportEntry>();
// Bounded LRU-ish cap: keep at most 32 entries across all (file, format,
// ratio) combinations to avoid leaking memory on a long-running server.
const MAX_CACHE_ENTRIES = 32;

async function exportKeyFor(filePath: string): Promise<string> {
  const st = await fs.stat(filePath);
  return `${filePath}::${st.mtimeMs}::${st.size}`;
}

/** Normalise the ratio for use as a cache slot — 3 decimal places is plenty. */
function ratioSlot(ratio: number): string {
  return clampRatio(ratio).toFixed(3);
}

function cacheSlot(
  format: ExportFormat,
  filePath: string,
  ratio: number,
  maxTris?: number,
): string {
  return `${format}::${decimSlot(ratio, maxTris)}::${filePath}`;
}

async function getCachedExport(
  format: ExportFormat,
  filePath: string,
  ratio: number,
  maxTris?: number,
): Promise<Buffer | null> {
  const slot = cacheSlot(format, filePath, ratio, maxTris);
  const e = exportCache.get(slot);
  if (!e) return null;
  const key = await exportKeyFor(filePath);
  if (e.key !== key) return null;
  exportCache.delete(slot);
  exportCache.set(slot, e);
  return e.data;
}

async function setCachedExport(
  format: ExportFormat,
  filePath: string,
  ratio: number,
  data: Buffer,
  maxTris?: number,
): Promise<Buffer> {
  const key = await exportKeyFor(filePath);
  const slot = cacheSlot(format, filePath, ratio, maxTris);
  exportCache.set(slot, { key, data });
  while (exportCache.size > MAX_CACHE_ENTRIES) {
    const oldest = exportCache.keys().next().value;
    if (!oldest) break;
    exportCache.delete(oldest);
  }
  return data;
}

/** Returns true if any decimation has been requested. */
function needsSimplifier(ratio: number, maxTris: number | undefined): boolean {
  return maxTris !== undefined || ratio < 1;
}

/**
 * Pull `?ratio=` off the query string. Accepts either a fraction (0.25) or a
 * percentage (25). Defaults to 1.0 (no decimation) when missing/invalid.
 */
function pickRatio(raw: unknown): number {
  if (raw === undefined || raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // If the caller passed a percentage like "25", convert to 0.25.
  return clampRatio(n > 1 ? n / 100 : n);
}

/**
 * Pull `?maxTris=` off the query string.
 * Returns undefined when missing/invalid (meaning: use ratio mode instead).
 */
function pickMaxTris(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

/** Cache slot that encodes both decimation parameters. */
function decimSlot(ratio: number, maxTris: number | undefined): string {
  if (maxTris !== undefined) return `maxtris-${maxTris}`;
  return `ratio-${ratioSlot(ratio)}`;
}

function pickFilePath(name: unknown): string {
  if (typeof name === "string" && name.length > 0) {
    return resolveEdmPath(name);
  }
  return getSampleFilePath();
}

router.get("/edm/files", async (_req, res, next) => {
  try {
    const files = await listEdmFiles();
    res.json({ files });
  } catch (err) {
    next(err);
  }
});

/**
 * Upload an .edm file. The browser sends the raw bytes as the request body
 * with the file name in the `X-Filename` header. We stream straight to disk
 * to avoid buffering 100+ MB in memory, then validate the magic bytes and
 * delete the file again if it isn't a real EDM.
 *
 * Limit: 512 MiB. Beyond that the server replies 413.
 */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

router.post("/edm/upload", async (req, res, next) => {
  let tmpPath: string | null = null;
  try {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_UPLOAD_BYTES) {
      res.status(413).json({
        error: `File too large: ${declared} bytes (max ${MAX_UPLOAD_BYTES}).`,
      });
      return;
    }

    const headerName =
      typeof req.headers["x-filename"] === "string"
        ? req.headers["x-filename"]
        : "upload.edm";
    const fileName = sanitiseUploadName(headerName);

    await ensureUploadsDir();
    const finalPath = path.join(getUploadsDir(), fileName);
    tmpPath = `${finalPath}.part-${process.pid}-${Date.now()}`;

    let received = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_BYTES && !aborted) {
        aborted = true;
        req.destroy(new Error("upload exceeds size limit"));
      }
    });

    await pipeline(req, createWriteStream(tmpPath));

    if (received < 9) {
      await fs.unlink(tmpPath).catch(() => {});
      tmpPath = null;
      res.status(400).json({ error: "Uploaded file is too small to be EDM." });
      return;
    }

    // Validate magic bytes before promoting the temp file.
    const fh = await fs.open(tmpPath, "r");
    const head = Buffer.alloc(3);
    await fh.read(head, 0, 3, 0);
    await fh.close();
    if (head.toString("ascii") !== "EDM") {
      await fs.unlink(tmpPath).catch(() => {});
      tmpPath = null;
      res.status(400).json({
        error: `Not an EDM file (magic="${head.toString("ascii")}").`,
      });
      return;
    }

    await fs.rename(tmpPath, finalPath);
    tmpPath = null;
    // Invalidate caches so any prior parse for the same name is dropped.
    bodyCache = null;
    exportCache.clear();

    const st = await fs.stat(finalPath);
    res.status(201).json({
      file: {
        filePath: finalPath,
        fileName,
        fileSize: st.size,
        modifiedAt: st.mtime.toISOString(),
        source: "upload" as const,
      },
    });
  } catch (err) {
    if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
    next(err);
  }
});

/**
 * Chunked upload — receive one 5 MB slice.
 * Headers: X-Upload-Id (uuid), X-Chunk-Index (0-based), X-Total-Chunks, X-Filename
 */
const MAX_CHUNK_BYTES = 10 * 1024 * 1024; // 10 MiB hard limit per chunk

router.post("/edm/upload/chunk", async (req, res, next) => {
  try {
    const uploadId = req.headers["x-upload-id"];
    const chunkIndex = Number(req.headers["x-chunk-index"]);
    const totalChunks = Number(req.headers["x-total-chunks"]);
    const headerName = req.headers["x-filename"];

    if (
      typeof uploadId !== "string" ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(uploadId) ||
      !Number.isFinite(chunkIndex) ||
      chunkIndex < 0 ||
      !Number.isFinite(totalChunks) ||
      totalChunks < 1 ||
      typeof headerName !== "string"
    ) {
      res.status(400).json({ error: "Invalid chunk headers." });
      return;
    }

    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_CHUNK_BYTES) {
      res.status(413).json({ error: "Chunk too large." });
      return;
    }

    await ensureChunksDir();
    const uploadDir = path.join(getChunksDir(), uploadId);
    await fs.mkdir(uploadDir, { recursive: true });

    const chunkPath = path.join(uploadDir, String(chunkIndex));
    await pipeline(req, createWriteStream(chunkPath));

    res.json({ ok: true, chunkIndex });
  } catch (err) {
    next(err);
  }
});

/**
 * Chunked upload — assemble all chunks into a final file.
 * Body: { uploadId, totalChunks, filename }
 */
router.post(
  "/edm/upload/assemble",
  express.json({ limit: "4kb" }),
  async (req, res, next) => {
    let finalPath: string | null = null;
    try {
      const { uploadId, totalChunks, filename } = req.body as {
        uploadId?: unknown;
        totalChunks?: unknown;
        filename?: unknown;
      };

      if (
        typeof uploadId !== "string" ||
        !/^[a-zA-Z0-9_-]{8,128}$/.test(uploadId) ||
        typeof totalChunks !== "number" ||
        totalChunks < 1 ||
        totalChunks > 10000 ||
        typeof filename !== "string"
      ) {
        res.status(400).json({ error: "Invalid assemble request." });
        return;
      }

      const uploadDir = path.join(getChunksDir(), uploadId);
      const sanitised = sanitiseUploadName(filename);
      await ensureUploadsDir();
      finalPath = path.join(getUploadsDir(), sanitised);

      // Concatenate chunks in order.
      const writeStream = createWriteStream(finalPath);
      for (let i = 0; i < totalChunks; i++) {
        const chunkPath = path.join(uploadDir, String(i));
        const data = await fs.readFile(chunkPath);
        await new Promise<void>((resolve, reject) =>
          writeStream.write(data, (err) => (err ? reject(err) : resolve())),
        );
      }
      await new Promise<void>((resolve, reject) =>
        writeStream.end((err?: Error | null) =>
          err ? reject(err) : resolve(),
        ),
      );

      // Validate EDM magic.
      const fh = await fs.open(finalPath, "r");
      const head = Buffer.alloc(3);
      await fh.read(head, 0, 3, 0);
      await fh.close();
      if (head.toString("ascii") !== "EDM") {
        await fs.unlink(finalPath).catch(() => {});
        finalPath = null;
        res.status(400).json({
          error: `Not an EDM file (magic="${head.toString("ascii")}").`,
        });
        return;
      }

      // Cleanup chunks.
      await fs.rm(uploadDir, { recursive: true }).catch(() => {});

      // Invalidate body/export caches.
      bodyCache = null;
      exportCache.clear();

      const st = await fs.stat(finalPath);
      res.status(201).json({
        file: {
          filePath: finalPath,
          fileName: sanitised,
          fileSize: st.size,
          modifiedAt: st.mtime.toISOString(),
          source: "upload" as const,
        },
      });
    } catch (err) {
      if (finalPath) await fs.unlink(finalPath).catch(() => {});
      next(err);
    }
  },
);

/**
 * Delete an uploaded file. Sample files in `attached_assets/` are
 * read-only — attempting to delete them returns 403.
 */
router.delete("/edm/files/:name", async (req, res, next) => {
  try {
    const safe = path.basename(req.params["name"] ?? "");
    if (!safe) {
      res.status(400).json({ error: "Missing file name." });
      return;
    }
    const target = path.join(getUploadsDir(), safe);
    if (!target.startsWith(getUploadsDir() + path.sep)) {
      res.status(403).json({ error: "Path traversal blocked." });
      return;
    }
    try {
      await fs.unlink(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        res.status(404).json({
          error: "File not found in uploads (samples cannot be deleted).",
        });
        return;
      }
      throw err;
    }
    bodyCache = null;
    exportCache.clear();
    res.json({ ok: true, fileName: safe });
  } catch (err) {
    next(err);
  }
});

router.get("/edm/header", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const header = await readHeader(filePath);
    res.json(header);
  } catch (err) {
    next(err);
  }
});

router.get("/edm/strings", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const table = await readStringTable(filePath);
    res.json(table);
  } catch (err) {
    next(err);
  }
});

router.get("/edm/string-usage", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const usage = await scanStringReferences(filePath);
    res.json({ usage });
  } catch (err) {
    next(err);
  }
});

router.get("/edm/body", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const parsed = await getParsed(filePath);

    // Trim heavy fields out of the JSON response. The full mesh data lives
    // behind the export endpoints; this view is for the inspector UI.
    const summary = {
      version: parsed.version,
      stringBlobSize: parsed.stringBlobSize,
      stringTableLength: parsed.stringTable.length,
      bodyStart: parsed.bodyStart,
      indexA: parsed.indexA,
      indexB: parsed.indexB,
      typeCount: parsed.typeCount,
      trailingBytes: parsed.trailingBytes,
      root: {
        name: parsed.root.name,
        version: parsed.root.version,
        boundingBoxMin: parsed.root.boundingBoxMin,
        boundingBoxMax: parsed.root.boundingBoxMax,
        materials: parsed.root.materials.map((m) => ({
          index: m.index,
          name: m.name ?? null,
          materialName: m.material_name ?? null,
          blending: m.blending ?? null,
          depthBias: m.depth_bias ?? null,
          vertexFormat: m.vertex_format
            ? {
                data: m.vertex_format.data,
                position: m.vertex_format.nposition,
                normal: m.vertex_format.nnormal,
                texture: m.vertex_format.ntexture,
              }
            : null,
          textures:
            m.textures?.map((t) => ({ index: t.index, name: t.name })) ?? [],
        })),
        propsKeys: Object.keys(parsed.root.props),
      },
      nodes: parsed.nodes.map((n) => ({
        index: n.index ?? null,
        type: n.typeName,
        name: n.name,
        parent: n.parentIndex ?? null,
      })),
      connectors: parsed.connectors.map((c) => ({
        name: c.name,
        parent: c.parent,
        data: c.data,
      })),
      renderNodes: parsed.renderNodes.map((rn, i) => ({
        index: i,
        name: rn.name,
        material: rn.material,
        vertexCount: rn.vertex.count,
        vertexStride: rn.vertex.stride,
        triangleCount: Math.floor(rn.indexBuffer.data.length / 3),
        indexCount: rn.indexBuffer.data.length,
        indexWidth: rn.indexBuffer.width,
        parentData: rn.parentData,
      })),
      shellNodes: parsed.shellNodes.map((sn) => ({
        name: sn.name,
        parent: sn.parent,
        vertexCount: sn.vertex.count,
        vertexStride: sn.vertex.stride,
        triangleCount: Math.floor(sn.indexBuffer.data.length / 3),
      })),
      lightNodes: parsed.lightNodes.map((l) => ({
        type: l.typeName,
        name: l.name,
      })),
      totals: {
        vertices: parsed.renderNodes.reduce(
          (s, rn) => s + rn.vertex.count,
          0,
        ),
        triangles: parsed.renderNodes.reduce(
          (s, rn) => s + Math.floor(rn.indexBuffer.data.length / 3),
          0,
        ),
      },
    };
    res.json(summary);
  } catch (err) {
    next(err);
  }
});

// Temporary diagnostic: expose animBase + baked bbox per render node
router.get("/edm/debug/bake", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const parsed = await getParsed(filePath);
    const { bakeAllDebug } = await import("../lib/edm-export");
    const bboxes = bakeAllDebug(parsed);
    res.json({ bboxes });
  } catch (err) {
    next(err);
  }
});

function sendDownload(
  res: import("express").Response,
  buf: Buffer,
  fileName: string,
  contentType: string,
): void {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`,
  );
  // NOTE: Do NOT set Content-Length here. Sending a large buffered response
  // with a fixed Content-Length causes Cloud Run's frontend proxy to reject
  // anything over ~32 MiB (it returns 500 to the client even when our app
  // returned 200). Using chunked transfer encoding via repeated res.write()
  // sidesteps that limit and works for arbitrarily large export payloads.
  const CHUNK = 1024 * 1024; // 1 MiB
  let offset = 0;
  const writeNext = (): void => {
    while (offset < buf.length) {
      const end = Math.min(offset + CHUNK, buf.length);
      const slice = buf.subarray(offset, end);
      offset = end;
      const ok = res.write(slice);
      if (!ok) {
        res.once("drain", writeNext);
        return;
      }
    }
    res.end();
  };
  writeNext();
}

router.get("/edm/export/obj", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const ratio = pickRatio(req.query["ratio"]);
    const maxTris = pickMaxTris(req.query["maxTris"]);
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    let buf = await getCachedExport("obj", filePath, ratio, maxTris);
    if (!buf) {
      if (needsSimplifier(ratio, maxTris)) await ensureSimplifierReady();
      const parsed = await getParsed(filePath);
      const result = exportObj(parsed, baseName, { ratio, maxTris });
      buf = await setCachedExport(
        "obj",
        filePath,
        ratio,
        Buffer.from(result.obj, "utf8"),
        maxTris,
      );
      await setCachedExport(
        "mtl",
        filePath,
        1,
        Buffer.from(result.mtl, "utf8"),
      );
    }
    sendDownload(res, buf, `${baseName}.obj`, "model/obj");
  } catch (err) {
    next(err);
  }
});

router.get("/edm/export/mtl", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    // Materials don't depend on the simplifier — always cache under ratio=1.
    let buf = await getCachedExport("mtl", filePath, 1);
    if (!buf) {
      const parsed = await getParsed(filePath);
      const result = exportObj(parsed, baseName);
      await setCachedExport(
        "obj",
        filePath,
        1,
        Buffer.from(result.obj, "utf8"),
      );
      buf = await setCachedExport(
        "mtl",
        filePath,
        1,
        Buffer.from(result.mtl, "utf8"),
      );
    }
    sendDownload(res, buf, `${baseName}.mtl`, "model/mtl");
  } catch (err) {
    next(err);
  }
});

router.get("/edm/export/fbx", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const ratio = pickRatio(req.query["ratio"]);
    const maxTris = pickMaxTris(req.query["maxTris"]);
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    let buf = await getCachedExport("fbx", filePath, ratio, maxTris);
    if (!buf) {
      if (needsSimplifier(ratio, maxTris)) await ensureSimplifierReady();
      const parsed = await getParsed(filePath);
      buf = await setCachedExport(
        "fbx",
        filePath,
        ratio,
        exportFbxBinary(parsed, baseName, { ratio, maxTris }),
        maxTris,
      );
    }
    sendDownload(res, buf, `${baseName}.fbx`, "application/octet-stream");
  } catch (err) {
    next(err);
  }
});

router.get("/edm/export/glb", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const ratio = pickRatio(req.query["ratio"]);
    const maxTris = pickMaxTris(req.query["maxTris"]);
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    let buf = await getCachedExport("glb", filePath, ratio, maxTris);
    if (!buf) {
      if (needsSimplifier(ratio, maxTris)) await ensureSimplifierReady();
      const parsed = await getParsed(filePath);
      buf = await setCachedExport(
        "glb",
        filePath,
        ratio,
        exportGlb(parsed, { ratio, maxTris }),
        maxTris,
      );
    }
    sendDownload(res, buf, `${baseName}.glb`, "model/gltf-binary");
  } catch (err) {
    next(err);
  }
});

/**
 * GLB export with connected-component (mesh island) splitting.
 * Every disconnected piece of geometry in every render node becomes its own
 * mesh node in the glTF scene — radar, cannons, missile tubes, etc. all
 * appear as separate objects when opened in Blender / Maya / Unreal.
 * ?ratio=        — optional decimation (same as /export/glb)
 * ?minTris=      — minimum triangle count per island (default 100)
 * ?weldEpsilon=  — position weld grid size in metres (default 0.001 = 1 mm)
 * ?dedup=false   — disable cross-render-node duplicate face removal
 */
router.get("/edm/export/glb-islands", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const ratio = pickRatio(req.query["ratio"]);
    const maxTris = pickMaxTris(req.query["maxTris"]);
    const rawMin = Number(req.query["minTris"] ?? 100);
    const minTris = Number.isFinite(rawMin) && rawMin >= 1 ? Math.round(rawMin) : 100;
    const rawEps = Number(req.query["weldEpsilon"] ?? 0.001);
    const weldEpsilon = Number.isFinite(rawEps) && rawEps > 0 ? rawEps : 0.001;
    const deduplicateFaces = String(req.query["dedup"] ?? "true") !== "false";
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    if (needsSimplifier(ratio, maxTris)) await ensureSimplifierReady();
    const parsed = await getParsed(filePath);
    const buf = exportGlb(parsed, {
      ratio,
      maxTris,
      splitIslands: true,
      minIslandTris: minTris,
      weldEpsilon,
      deduplicateFaces,
    });
    sendDownload(res, buf, `${baseName}_islands.glb`, "model/gltf-binary");
  } catch (err) {
    next(err);
  }
});

/**
 * OBJ export with connected-component (mesh island) splitting.
 * Same island logic as /export/glb-islands but in text OBJ format.
 */
router.get("/edm/export/obj-islands", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const ratio = pickRatio(req.query["ratio"]);
    const maxTris = pickMaxTris(req.query["maxTris"]);
    const rawMin = Number(req.query["minTris"] ?? 100);
    const minTris = Number.isFinite(rawMin) && rawMin >= 1 ? Math.round(rawMin) : 100;
    const rawEps = Number(req.query["weldEpsilon"] ?? 0.001);
    const weldEpsilon = Number.isFinite(rawEps) && rawEps > 0 ? rawEps : 0.001;
    const deduplicateFaces = String(req.query["dedup"] ?? "true") !== "false";
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    if (needsSimplifier(ratio, maxTris)) await ensureSimplifierReady();
    const parsed = await getParsed(filePath);
    const result = exportObj(parsed, baseName, {
      ratio,
      maxTris,
      splitIslands: true,
      minIslandTris: minTris,
      weldEpsilon,
      deduplicateFaces,
    });

    const zipEntries: Record<string, Uint8Array> = {
      [`${baseName}_islands.obj`]: strToU8(result.obj),
      [`${baseName}.mtl`]: strToU8(result.mtl),
    };
    const zipBuf = Buffer.from(zipSync(zipEntries));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${baseName}_islands.zip"`);
    res.setHeader("Content-Length", String(zipBuf.length));
    res.end(zipBuf);
  } catch (err) {
    next(err);
  }
});

router.get("/edm/export/zip-split", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const ratio = pickRatio(req.query["ratio"]);
    const maxTris = pickMaxTris(req.query["maxTris"]);
    const baseName = path.basename(filePath).replace(/\.edm$/i, "") || "model";
    if (needsSimplifier(ratio, maxTris)) await ensureSimplifierReady();
    const parsed = await getParsed(filePath);
    const result = exportObjSplit(parsed, baseName, { ratio, maxTris });

    const zipEntries: Record<string, Uint8Array> = {};
    for (const obj of result.objects) {
      zipEntries[`${baseName}/${obj.name}`] = strToU8(obj.obj);
    }
    zipEntries[`${baseName}/${baseName}.mtl`] = strToU8(result.mtl);

    const zipBuf = Buffer.from(zipSync(zipEntries));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${baseName}_split.zip"`,
    );
    res.setHeader("Content-Length", String(zipBuf.length));
    res.end(zipBuf);
  } catch (err) {
    next(err);
  }
});

router.get("/edm/hex", async (req, res, next) => {
  try {
    const filePath = pickFilePath(req.query["file"]);
    const offset = Number(req.query["offset"] ?? 0);
    const length = Number(req.query["length"] ?? 256);
    if (!Number.isFinite(offset) || !Number.isFinite(length)) {
      res.status(400).json({ error: "offset and length must be numbers" });
      return;
    }
    const chunk = await readHexChunk(filePath, offset, length);
    res.json(chunk);
  } catch (err) {
    next(err);
  }
});

export default router;
