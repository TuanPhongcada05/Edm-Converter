# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Hosts the **EDM File Inspector** — a
web app that parses and explores DCS World `.edm` binary files.

## Artifacts

- `artifacts/edm-viewer` (`/`) — React + Vite frontend that renders the EDM
  inspector UI: header summary, string table, hex viewer, and reference-frequency
  scan.
- `artifacts/api-server` — shared Express 5 API. Hosts the EDM parser (no DB).
- `artifacts/mockup-sandbox` — design canvas, unused for the EDM viewer.

## EDM v10 format (what the parser knows)

```
offset  size  field
  0      3    magic = "EDM"
  3      2    version (uint16 LE)        = 10 for our sample
  5      4    string count (uint32 LE)
  9      *    string table = N null-terminated UTF-8 strings
  *      *    body — references the strings by index
```

The string table acts as a global symbol table for everything that follows
(property names, material names, texture paths, node names, etc.).

**Body parser is now complete for EDM v10** — Tarantul_Corvette sample parses
cleanly to 0 trailing bytes: 28 RenderNodes, 1.5M vertices, 1.13M triangles,
16 materials, 32 connectors, 674 TransformNodes, plus the full animation node
hierarchy.

### v10 deltas vs v8 (verified empirically)
1. String table prefix is **byte size** (uint32) of the blob, not the entry
   count. Strings are null-separated inside the blob.
2. `model::RootNode` does NOT have the leading `unknownA` uchar that v8 has —
   bbox doubles start immediately after BaseNode.
3. `model::ArgVisibilityNode` appends an extra **64-byte mat4f** (typically
   identity) after `visData` that v8 does not have.

## Body / export pipeline

- `artifacts/api-server/src/lib/edm-body.ts` — full body parser (RootNode,
  materials, transform/animation nodes, render/shell/light/connector lists).
- `artifacts/api-server/src/lib/edm-export.ts` — converts a `ParsedEdmFile`
  into Wavefront OBJ + MTL, binary glTF 2.0 (.glb), or FBX 7.4 **binary**
  (Blender refuses ASCII FBX, so we emit the binary container). Bakes every
  render node into world space so Blender / Maya / 3ds Max all show the ship
  correctly assembled (no need for the tools to honour any node hierarchy).
- `artifacts/api-server/src/lib/fbx-binary.ts` — standalone FBX 7.4 binary
  encoder (FbxNode tree, typed properties Y/C/I/F/D/L/R/S + zlib-deflated
  array properties f/d/i/l/b, header magic, footer code, null-record sentinel
  rules: emit after children OR for empty container nodes).
- `GET /api/edm/body?file=…` — JSON summary (counts, render-node table).
- `GET /api/edm/export/obj` / `/mtl` / `/glb` / `/fbx` — file downloads served
  with `Content-Disposition: attachment`.
- `GET /api/edm/export/zip-split` — ZIP archive with one `.obj` per render node
  plus a shared `.mtl`. Built with `fflate`.
- `GET /api/edm/export/glb-islands?minTris=100` — GLB export with connected-component
  (mesh island) splitting. Every disconnected geometry island in every render node becomes
  its own mesh node. `minTris` (default 100) sets the minimum triangle count per island;
  smaller fragments are merged into a catch-all misc mesh.
- `GET /api/edm/export/obj-islands?minTris=100` — same island logic but returns a ZIP
  containing an OBJ + MTL file pair.
- Island splitting uses a two-pass algorithm in `edm-export.ts`:
  1. `deduplicateAcrossMeshes()` — removes triangles whose 3 quantised world-space
     positions match a face already seen in an earlier render node (eliminates
     Z-fighting from overlapping DCS render nodes; reduces file size ~40–50%).
  2. `splitByIslands()` with `buildWeldMap()` — position-based vertex welding
     (1 mm grid) maps seam/boundary duplicate verts to canonical indices before
     running Union-Find with path-halving + rank union, so parts that physically
     touch via seam verts are correctly fused into one island.
  Typical island counts for the Tarantul sample after improvements:
  minTris=1000 → 84 meshes (34 MB), minTris=100 → 1401 meshes (33 MB).
  Old behaviour without improvements: minTris=1000 → 55 meshes (72 MB, bad splits).
- `POST /api/edm/upload` — accepts the raw EDM bytes (Content-Type
  `application/octet-stream`, file name in `X-Filename` header), streams them
  to `data/edm-uploads/<name>.part-…`, validates the `EDM` magic, then
  atomically renames into place. 512 MiB cap. Aborted uploads are cleaned up
  by `cleanupStaleUploads()` at server boot.
- `DELETE /api/edm/files/:name` — removes an uploaded file. Sample files in
  `attached_assets/` are read-only (returns 404 — they're not in the uploads
  dir, so the lookup misses on purpose).
- `EdmFileInfo.source` is `"upload"` for files in `data/edm-uploads/` and
  `"sample"` for files in `attached_assets/`. The viewer prefixes upload rows
  in the picker with `↑` and shows a delete button only for uploads.
- `getParsed()` in the route caches one parsed body keyed by mtimeMs+size,
  and `exportCache` memoises the OBJ/MTL/GLB/FBX bytes per (file, format,
  ratio) so repeated downloads of the 92 MB sample come back in ~1 s instead
  of ~40 s. The cache is bounded LRU-ish (32 entries) and invalidated per
  file when mtime/size changes.

### Triangle decimation (`?ratio=`)

- `artifacts/api-server/src/lib/decimate.ts` — wraps `meshoptimizer`'s WASM
  quadric-error simplifier. `bakeAll(parsed, { ratio })` runs every
  `BakedMesh` through `simplifyIndices(positions, indices, ratio)`, which
  rewrites the index buffer down to `ratio * tris` triangles. Vertex /
  normal / UV buffers are untouched, so OBJ / GLB / FBX exporters need no
  other changes. Flag set: `["Prune"]` (drops tiny disconnected fragments,
  preserving the overall silhouette). `LockBorder` is intentionally NOT
  used — every render node is its own connected piece, so pinning all open
  edges would leave the simplifier almost nothing to collapse.
- `MeshoptSimplifier.ready` is awaited once per process via
  `ensureSimplifierReady()` before the first decimation; subsequent calls
  are fully synchronous.
- All four export endpoints (`/obj`, `/fbx`, `/glb`, `/zip-split`) accept
  `?ratio=` as either a fraction (`0.25`) or a percentage (`25`). Default
  is 1.0 (no decimation). MTL is ratio-independent and always cached at
  ratio = 1. The ExportPanel exposes 100 / 75 / 50 / 25 / 10% presets.

### World-matrix baking (the tricky part)

EDM stores meshes in a deeply nested transform hierarchy, but with a twist:
the `model::TransformNode.animBase.matrix` is **always identity**. The real
rest pose lives in `animBase.position`, `animBase.quat_1` (a
`(w,x,y,z)` quaternion), and `animBase.scale`, which we compose into a
T·R·S local matrix via `makeTRS()`. World matrices are built by walking the
`parents[]` array up to the root.

Render nodes are skinned in a lightweight way: `RenderNode.parentData[]` is
the **bone list** (each entry references a node in `nodes[]`), and when the
material's vertex format declares a 4-float position channel, the **4th
float of every vertex is its bone index** into `parentData`. This is how
DCS keeps things like propeller shafts, deck guns, antennas and hatches
glued to the right transform without spawning a render node per part. The
exporter applies the matching bone's world matrix per vertex; render nodes
with a single parent (e.g. flags) just use `parentData[0]` for everything.

## Backend layout

- `artifacts/api-server/src/lib/edm-parser.ts` — pure parser functions:
  `readHeader`, `readStringTable`, `readHexChunk`, `scanStringReferences`. Reads
  files from `attached_assets/` via `createReadStream` so 100 MB+ files don't
  hit memory.
- `artifacts/api-server/src/routes/edm.ts` — REST surface:
  - `GET /api/edm/files` — list `.edm` files in `attached_assets/`
  - `GET /api/edm/header?file=…` — parsed header
  - `GET /api/edm/strings?file=…` — full string table
  - `GET /api/edm/hex?file=…&offset=…&length=…` — random-access hex slice
  - `GET /api/edm/string-usage?file=…` — index-frequency scan (≤16 MB body
    window for speed)

The `file` query param is optional; if omitted, the server falls back to the
sample `Tarantul_Corvette_1777211022937.EDM`. Path traversal is blocked via
`path.basename`.

## Frontend layout

- `artifacts/edm-viewer/src/pages/Inspector.tsx` — top-level layout, file
  picker, summary cards, tab shell. Default tab is **Preview 3D**.
- `artifacts/edm-viewer/src/components/Viewer3D.tsx` — three.js + OrbitControls
  in-browser 3D preview (SketchUp-style). Loads `/api/edm/export/glb`, replaces
  materials with a flat MeshStandardMaterial (DCS .dds textures aren't bundled),
  auto-fits camera + grid + axes to the model bounding sphere. Toolbar exposes
  ISO / Front / Back / Left / Right / Top / Bottom views, Shaded / Wire /
  Shaded+Wire shading modes, grid toggle, axes toggle and dark/light background.
- `artifacts/edm-viewer/src/components/ExportPanel.tsx` — Vietnamese-language
  export UI: 3 download cards (OBJ + MTL, GLB, FBX) plus tables of render
  nodes and materials.
- `artifacts/edm-viewer/src/components/HeaderPanel.tsx` — annotated header table.
- `artifacts/edm-viewer/src/components/StringsPanel.tsx` — searchable string
  table with control-character escaping.
- `artifacts/edm-viewer/src/components/HexPanel.tsx` — paged hex dump with
  decimal/hex offset input and quick-jump buttons.
- `artifacts/edm-viewer/src/components/UsagePanel.tsx` — sortable list of
  most-referenced strings with frequency bars.
- `artifacts/edm-viewer/src/lib/api.ts` — typed fetch wrapper that prepends the
  artifact's `BASE_URL` so requests survive the workspace path proxy.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React 19 + Vite 7 + TanStack Query + Tailwind v4 + Radix UI
- **API framework**: Express 5
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Build**: esbuild (CJS bundle for the API server)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-server run dev` — run API server locally
- `pnpm --filter @workspace/edm-viewer run dev` — run the inspector frontend
