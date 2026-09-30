// Builds a URL that respects the artifact's BASE_URL prefix.
// The proxy strips this prefix before forwarding to the api-server.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${BASE}/api${p}`;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface EdmFileInfo {
  filePath: string;
  fileName: string;
  fileSize: number;
  modifiedAt: string;
  source?: "sample" | "upload";
}
export interface EdmHeader {
  magic: string;
  version: number;
  stringCount: number;
  stringTableEnd: number;
  fileSize: number;
}
export interface EdmStringTable {
  count: number;
  endOffset: number;
  strings: string[];
}
export interface HexChunk {
  offset: number;
  length: number;
  fileSize: number;
  hex: string;
  ascii: string;
}
export interface StringIndexUsage {
  index: number;
  value: string;
  references: number;
}

export interface EdmBodySummary {
  version: number;
  stringBlobSize: number;
  stringTableLength: number;
  bodyStart: number;
  trailingBytes: number;
  root: {
    name: string;
    version: number;
    boundingBoxMin: [number, number, number];
    boundingBoxMax: [number, number, number];
    materials: Array<{
      index: number;
      name: string | null;
      materialName: string | null;
      blending: number | null;
      depthBias: number | null;
      vertexFormat: { data: number[]; position: number; normal: number; texture: number } | null;
      textures: Array<{ index: number; name: string }>;
    }>;
  };
  nodes: Array<{ index: number | null; type: string; name: string; parent: number | null }>;
  connectors: Array<{ name: string; parent: number; data: number }>;
  renderNodes: Array<{
    index: number;
    name: string;
    material: number;
    vertexCount: number;
    vertexStride: number;
    triangleCount: number;
    indexCount: number;
    indexWidth: number;
  }>;
  shellNodes: Array<{ name: string; parent: number; vertexCount: number; vertexStride: number; triangleCount: number }>;
  lightNodes: Array<{ type: string; name: string }>;
  totals: { vertices: number; triangles: number };
}

export const api = {
  files: () => getJson<{ files: EdmFileInfo[] }>("/edm/files"),
  header: (file?: string) =>
    getJson<EdmHeader>(`/edm/header${file ? `?file=${encodeURIComponent(file)}` : ""}`),
  strings: (file?: string) =>
    getJson<EdmStringTable>(`/edm/strings${file ? `?file=${encodeURIComponent(file)}` : ""}`),
  hex: (offset: number, length: number, file?: string) =>
    getJson<HexChunk>(
      `/edm/hex?offset=${offset}&length=${length}${file ? `&file=${encodeURIComponent(file)}` : ""}`,
    ),
  usage: (file?: string) =>
    getJson<{ usage: StringIndexUsage[] }>(
      `/edm/string-usage${file ? `?file=${encodeURIComponent(file)}` : ""}`,
    ),
  body: (file?: string) =>
    getJson<EdmBodySummary>(`/edm/body${file ? `?file=${encodeURIComponent(file)}` : ""}`),
  exportUrl: (
    format: "obj" | "mtl" | "glb" | "fbx" | "zip-split" | "glb-islands" | "obj-islands",
    file?: string,
    maxTris?: number,
    extraParams?: Record<string, string>,
  ) => {
    const params: string[] = [];
    if (file) params.push(`file=${encodeURIComponent(file)}`);
    // Use global triangle budget — more reliable than per-mesh ratio.
    if (typeof maxTris === "number" && maxTris > 0) {
      params.push(`maxTris=${Math.round(maxTris)}`);
    }
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) {
        params.push(`${k}=${encodeURIComponent(v)}`);
      }
    }
    const qs = params.length ? `?${params.join("&")}` : "";
    return apiUrl(`/edm/export/${format}${qs}`);
  },
  upload: async (
    file: File,
    onProgress?: (sentBytes: number, totalBytes: number) => void,
  ): Promise<EdmFileInfo> => {
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB per chunk
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    const uploadId = crypto.randomUUID().replace(/-/g, "");

    let sent = 0;

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunk = file.slice(start, end);

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", apiUrl("/edm/upload/chunk"));
        xhr.setRequestHeader("Content-Type", "application/octet-stream");
        xhr.setRequestHeader("X-Upload-Id", uploadId);
        xhr.setRequestHeader("X-Chunk-Index", String(i));
        xhr.setRequestHeader("X-Total-Chunks", String(totalChunks));
        xhr.setRequestHeader("X-Filename", file.name);
        xhr.upload.onprogress = (e) => {
          if (onProgress) onProgress(sent + e.loaded, file.size);
        };
        xhr.onerror = () => reject(new Error("Network error uploading chunk."));
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            sent += end - start;
            if (onProgress) onProgress(sent, file.size);
            resolve();
          } else {
            let msg = `${xhr.status}`;
            try {
              const b = JSON.parse(xhr.responseText) as { error?: string };
              if (b.error) msg = b.error;
            } catch { /* ignore */ }
            reject(new Error(`Chunk ${i} failed: ${msg}`));
          }
        };
        xhr.send(chunk);
      });
    }

    const assembleRes = await fetch(apiUrl("/edm/upload/assemble"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uploadId, totalChunks, filename: file.name }),
    });
    if (!assembleRes.ok) {
      let msg = String(assembleRes.status);
      try {
        const b = await assembleRes.json() as { error?: string };
        if (b.error) msg = b.error;
      } catch { /* ignore */ }
      throw new Error(msg);
    }
    const data = await assembleRes.json() as { file: EdmFileInfo };
    return data.file;
  },
  deleteFile: async (fileName: string): Promise<void> => {
    const res = await fetch(apiUrl(`/edm/files/${encodeURIComponent(fileName)}`), {
      method: "DELETE",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${text}`);
    }
  },
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatHexOffset(n: number, width = 8): string {
  return "0x" + n.toString(16).padStart(width, "0");
}
