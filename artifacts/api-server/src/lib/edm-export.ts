/**
 * Export an already-parsed EDM file to common interchange formats.
 *
 *   - Wavefront OBJ + MTL  (text, easiest to import everywhere)
 *   - glTF 2.0 binary GLB  (efficient single-file binary)
 *   - Autodesk FBX 7.4 binary (Blender / Maya / Max native interchange)
 *
 * The vertex stream of every RenderNode in a DCS-World EDM follows the layout
 * described by its material's vertex_format byte array, where each entry is
 * the float-count for that channel:
 *
 *     channel 0 = position        (e.g. 4 floats: x y z w)
 *     channel 1 = normal          (e.g. 3 floats: nx ny nz)
 *     channel 4 = texture coord   (e.g. 2 floats: u v)
 *
 * Channels appear in the vertex stream in their numeric order; the offset of
 * texture coords is therefore data[0]+data[1]+data[2]+data[3] floats from the
 * start of each vertex.
 *
 * IMPORTANT: render-node vertices are stored in the *local* coordinate frame
 * of their parent transform node. To produce a coherent world-space model we
 * walk the parents[] chain and pre-multiply each TransformNode / animation
 * node's rest-pose matrix down the hierarchy, then bake that world matrix
 * into the vertex positions and normals before writing.
 */

import type {
  ParsedEdmFile,
  RenderNode,
  Material,
  BaseNodeData,
  Mat4,
} from "./edm-body";
import {
  encodeFbxBinary,
  type FbxNode,
  N,
  I,
  D,
  C,
  S,
  L,
  P,
  dArr,
  iArr,
  objId,
} from "./fbx-binary";
import { simplifyIndices, applyGlobalBudget } from "./decimate";

/**
 * Optional knobs for the export pipeline.
 *
 * ratio            — target fraction of triangles to keep (0..1). 1 = original.
 *                    Ignored when maxTris is provided.
 * maxTris          — global triangle budget: the server will distribute this
 *                    count across all meshes proportionally. Small meshes
 *                    (≤ 300 tris) are never touched. Takes priority over ratio.
 * splitIslands     — split every render node into connected-component sub-meshes.
 * minIslandTris    — minimum triangle count per island (default 100).
 * weldEpsilon      — grid cell size (metres) for position-based vertex welding
 *                    before running the island splitter. Vertices that land in
 *                    the same cell are treated as the same physical point, so
 *                    parts that share a seam but have duplicate boundary verts
 *                    are correctly fused into one island. Default: 0.001 (1 mm).
 * deduplicateFaces — remove triangles whose 3 world-space positions (quantised
 *                    by weldEpsilon) match a triangle already seen in an earlier
 *                    render node. Eliminates Z-fighting from overlapping geo.
 *                    Default: true (applied to all exports).
 * cleanMesh        — remove degenerate (zero-area) triangles from every mesh.
 *                    Degenerate faces occur when two or more vertices of a
 *                    triangle share the same world-space position, or when all
 *                    three vertices are collinear.  In Blender these show up as
 *                    isolated edge-loops and cause shading / Boolean errors.
 *                    Default: true (applied to all exports).
 */
export interface ExportOptions {
  ratio?: number;
  maxTris?: number;
  splitIslands?: boolean;
  minIslandTris?: number;
  weldEpsilon?: number;
  deduplicateFaces?: boolean;
  cleanMesh?: boolean;
  /** Dihedral angle threshold for island splitting (degrees, default 45).
   *  Edges whose adjacent face normals differ by MORE than this angle act as
   *  hard split boundaries.  Lower values produce more, smaller islands. */
  sharpAngleDeg?: number;
}

// ---------------------------------------------------------------------------
// Matrix math (column-major 4x4, OpenGL convention — same as the on-disk
// osg::Matrixd layout, so matrices are passed through verbatim).
// ---------------------------------------------------------------------------

const IDENTITY: Mat4 = [
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
];

function multiply4(a: Mat4, b: Mat4): Mat4 {
  const r: number[] = new Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      r[col * 4 + row] =
        a[row]! * b[col * 4]! +
        a[4 + row]! * b[col * 4 + 1]! +
        a[8 + row]! * b[col * 4 + 2]! +
        a[12 + row]! * b[col * 4 + 3]!;
    }
  }
  return r;
}

function transformPoint(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ];
}

function transformDirection(
  m: Mat4,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  // Use the upper-left 3x3 (no translation). This is correct for unit-norm
  // normals as long as the parent transform has no non-uniform scale, which
  // is the case for every DCS hierarchy I have inspected.
  const nx = m[0]! * x + m[4]! * y + m[8]! * z;
  const ny = m[1]! * x + m[5]! * y + m[9]! * z;
  const nz = m[2]! * x + m[6]! * y + m[10]! * z;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len < 1e-12) return [nx, ny, nz];
  return [nx / len, ny / len, nz / len];
}

// ---------------------------------------------------------------------------
// Channel layout / vertex extraction
// ---------------------------------------------------------------------------

interface ChannelLayout {
  stride: number;
  posOff: number;
  posLen: number;
  nrmOff: number;
  nrmLen: number;
  uvOff: number;
  uvLen: number;
}

function layoutFor(rn: RenderNode, mat: Material | undefined): ChannelLayout {
  const data = mat?.vertex_format?.data ?? [];
  const posLen = data[0] ?? 0;
  const nrmLen = data[1] ?? 0;
  const ch2 = data[2] ?? 0;
  const ch3 = data[3] ?? 0;
  const uvLen = data[4] ?? 0;
  return {
    stride: rn.vertex.stride,
    posOff: 0,
    posLen,
    nrmOff: posLen,
    nrmLen,
    uvOff: posLen + nrmLen + ch2 + ch3,
    uvLen,
  };
}

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_") || "Unnamed";
}

// ---------------------------------------------------------------------------
// Hierarchy traversal — local matrix per node + cached world matrices
// ---------------------------------------------------------------------------

/**
 * Compose a T·R·S column-major matrix from a translation vector, a unit
 * quaternion stored as (w, x, y, z), and a per-axis scale vector.
 */
function makeTRS(
  t: [number, number, number],
  q: [number, number, number, number],
  s: [number, number, number],
): Mat4 {
  const w = q[0]!, x = q[1]!, y = q[2]!, z = q[3]!;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  const sx = s[0]!, sy = s[1]!, sz = s[2]!;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}

function isUsefulMatrix(m: number[]): boolean {
  // Reject identity-but-also-zero-scale degenerate matrices that some nodes
  // ship by default (animBase.matrix is one of these).
  return Math.abs(m[0]!) > 1e-9 || Math.abs(m[5]!) > 1e-9 || Math.abs(m[10]!) > 1e-9;
}

function getLocalMatrix(node: BaseNodeData & Record<string, unknown>): Mat4 {
  // TransformNode stores its rest matrix on `matrix`.
  const m = node["matrix"];
  if (Array.isArray(m) && m.length === 16 && isUsefulMatrix(m as number[])) {
    return m as Mat4;
  }
  // ArgAnimationNode (and ArgRotationNode / ArgPositionNode / ArgScaleNode /
  // ArgAnimatedBone). The `animBase.matrix` field is identity in every file
  // I have inspected — the actual rest pose is stored in
  // animBase.position / animBase.quat_1 / animBase.scale and must be composed
  // here as T·R·S.
  const ab = node["animBase"] as
    | {
        matrix?: number[];
        position?: [number, number, number];
        quat_1?: [number, number, number, number];
        scale?: [number, number, number];
      }
    | undefined;
  if (ab) {
    const t = ab.position ?? [0, 0, 0];
    const q = ab.quat_1 ?? [1, 0, 0, 0];
    const s = ab.scale ?? [1, 1, 1];
    return makeTRS(t, q, s);
  }
  // Bones expose [restMatrix, otherMatrix].
  const ms = node["matrices"];
  if (
    Array.isArray(ms) &&
    ms.length > 0 &&
    Array.isArray(ms[0]) &&
    ms[0].length === 16 &&
    isUsefulMatrix(ms[0] as number[])
  ) {
    return ms[0] as Mat4;
  }
  return IDENTITY;
}

function buildWorldMatrices(parsed: ParsedEdmFile): Mat4[] {
  const cache: (Mat4 | null)[] = parsed.nodes.map(() => null);
  // Iterative resolver to avoid stack overflow on deep trees.
  for (let i = 0; i < parsed.nodes.length; i++) {
    if (cache[i]) continue;
    const stack: number[] = [];
    let cur = i;
    while (
      cur >= 0 &&
      cur < parsed.nodes.length &&
      !cache[cur]
    ) {
      stack.push(cur);
      const p = parsed.parents[cur];
      cur = p === undefined ? -1 : p;
    }
    let parentWorld: Mat4 =
      cur >= 0 && cur < parsed.nodes.length && cache[cur]
        ? cache[cur]!
        : IDENTITY;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const local = getLocalMatrix(parsed.nodes[idx]! as BaseNodeData & Record<string, unknown>);
      const world = multiply4(parentWorld, local);
      cache[idx] = world;
      parentWorld = world;
    }
  }
  return cache.map((m) => m ?? IDENTITY);
}

/**
 * RenderNode skinning model:
 *
 * `parentData[]` is the per-render-node bone list (each entry references a
 * node in `nodes[]`). When the vertex's position channel is 4 floats wide,
 * the 4th float is the **bone index into parentData[]** for that vertex —
 * this is how DCS World keeps small parts (propeller shafts, hatches,
 * antennas, deck guns…) glued to their correct world transform without
 * spawning a RenderNode per part.
 *
 * Render nodes whose parents all share the same transform (e.g. flags) work
 * the same way — every vertex gets bone index 0 and we apply parentData[0].
 */
function buildBoneWorldMatrices(
  rn: RenderNode,
  worldMatrices: Mat4[],
): Mat4[] {
  return rn.parentData.map((pd) => {
    const idx = pd[0];
    if (idx === undefined || idx < 0 || idx >= worldMatrices.length) {
      return IDENTITY;
    }
    return worldMatrices[idx]!;
  });
}

/** Pre-baked world-space POSITION + NORMAL + UV streams for one render node. */
interface BakedMesh {
  name: string;
  positions: Float32Array; // length = count * 3
  normals: Float32Array | null; // length = count * 3 (optional)
  uvs: Float32Array | null; // length = count * 2 (optional, V flipped)
  indices: Uint32Array;
  count: number;
  material: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

function bakeRenderNode(
  rn: RenderNode,
  mat: Material | undefined,
  bones: Mat4[],
): BakedMesh {
  const lo = layoutFor(rn, mat);
  const count = rn.vertex.count;
  const data = rn.vertex.data;
  const fallback = bones[0] ?? IDENTITY;

  // Per-vertex bone assignment.
  //
  // DCS render nodes are skinned via parentData[] (the bone list). When the
  // material's vertex format declares a 4-float position channel, the 4th
  // float of every vertex IS the bone index into parentData[] — this is how
  // DCS keeps small parts (flagpoles, deck guns, propellers, antennas, etc.)
  // glued to the right transform without spawning a render node per part.
  //
  // Encoding varies between DCS releases:
  //   - some files store the index as a plain float (1.0, 2.0, 3.0, …)
  //   - some files store the int32 bit-cast into the float slot
  // We auto-detect by sampling and pick whichever interpretation yields valid
  // indices for ~all sampled vertices.
  const vertexBone = new Int32Array(count); // default: bone 0
  if (bones.length > 1 && lo.posLen >= 4) {
    const i32 = new Int32Array(
      data.buffer,
      data.byteOffset,
      data.length,
    );
    const sample = Math.min(count, 64);
    let floatHits = 0;
    let intHits = 0;
    for (let v = 0; v < sample; v++) {
      const off = v * lo.stride + lo.posOff + 3;
      const f = data[off]!;
      const ft = Math.trunc(f);
      if (Number.isFinite(f) && ft >= 0 && ft < bones.length && ft === f) {
        floatHits++;
      }
      const it = i32[off]!;
      if (it >= 0 && it < bones.length) intHits++;
    }
    const useInt = intHits > floatHits;
    for (let v = 0; v < count; v++) {
      const off = v * lo.stride + lo.posOff + 3;
      const bi = useInt ? i32[off]! : Math.trunc(data[off]!);
      if (bi >= 0 && bi < bones.length) vertexBone[v] = bi;
    }
  }

  const positions = new Float32Array(count * 3);
  const normals = lo.nrmLen >= 3 ? new Float32Array(count * 3) : null;
  const uvs = lo.uvLen >= 2 ? new Float32Array(count * 2) : null;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let v = 0; v < count; v++) {
    const o = v * lo.stride;
    const world = bones[vertexBone[v]!] ?? fallback;

    const lx = data[o + lo.posOff]!;
    const ly = data[o + lo.posOff + 1]!;
    const lz = data[o + lo.posOff + 2]!;
    const [wx, wy, wz] = transformPoint(world, lx, ly, lz);
    positions[v * 3] = wx;
    positions[v * 3 + 1] = wy;
    positions[v * 3 + 2] = wz;
    if (wx < min[0]) min[0] = wx;
    if (wy < min[1]) min[1] = wy;
    if (wz < min[2]) min[2] = wz;
    if (wx > max[0]) max[0] = wx;
    if (wy > max[1]) max[1] = wy;
    if (wz > max[2]) max[2] = wz;

    if (normals) {
      const [nx, ny, nz] = transformDirection(
        world,
        data[o + lo.nrmOff]!,
        data[o + lo.nrmOff + 1]!,
        data[o + lo.nrmOff + 2]!,
      );
      normals[v * 3] = nx;
      normals[v * 3 + 1] = ny;
      normals[v * 3 + 2] = nz;
    }
    if (uvs) {
      uvs[v * 2] = data[o + lo.uvOff]!;
      // Flip V — DCS stores top-down, OBJ/glTF/FBX assume bottom-up.
      uvs[v * 2 + 1] = 1 - data[o + lo.uvOff + 1]!;
    }
  }

  const indices = new Uint32Array(rn.indexBuffer.data.length);
  for (let k = 0; k < rn.indexBuffer.data.length; k++) indices[k] = rn.indexBuffer.data[k]!;

  return {
    name: safeName(rn.name),
    positions,
    normals,
    uvs,
    indices,
    count,
    material: rn.material,
    bbox: { min, max },
  };
}

function bakeAll(
  parsed: ParsedEdmFile,
  opts?: ExportOptions,
): BakedMesh[] {
  const world = buildWorldMatrices(parsed);

  // ── Pre-pass: skip render nodes with duplicate names ─────────────────────
  // DCS models store multiple animation-state versions of the same component
  // (flag positions, damage overlays …) under identical node names.  Baking
  // all of them produces visually overlapping objects in Blender.  Keep only
  // the FIRST occurrence of each non-empty name so the rest-pose export has
  // exactly one copy of each named component.
  const seenRnNames = new Set<string>();
  const activeRenderNodes = parsed.renderNodes.filter((rn) => {
    if (!rn.name) return true; // always keep unnamed nodes
    if (seenRnNames.has(rn.name)) return false;
    seenRnNames.add(rn.name);
    return true;
  });

  const meshes = activeRenderNodes.map((rn) => {
    const mat = parsed.root.materials[rn.material];
    const bones = buildBoneWorldMatrices(rn, world);
    return bakeRenderNode(rn, mat, bones);
  });

  // Record original triangle counts so we can detect near-empty post-dedup fragments.
  const originalTriCounts = meshes.map((bm) => bm.indices.length / 3);

  const maxTris = opts?.maxTris;
  const ratio = opts?.ratio ?? 1;

  let result: BakedMesh[];

  // Global budget mode: distribute a fixed triangle count proportionally
  // across all meshes, protecting small ones from disappearing.
  if (typeof maxTris === "number" && maxTris > 0) {
    const reducedIndices = applyGlobalBudget(meshes, maxTris);
    result = meshes.map((bm, i) => ({ ...bm, indices: reducedIndices[i]! }));
  } else if (ratio < 0.999) {
    // Per-mesh ratio mode (legacy): apply the same ratio to every mesh.
    result = meshes.map((bm) => ({
      ...bm,
      indices: simplifyIndices(bm.positions, bm.indices, ratio),
    }));
  } else {
    result = meshes;
  }

  // ── Mesh cleaning passes ─────────────────────────────────────────────────
  // Pass 1: remove triangles whose world-space positions duplicate a triangle
  //         already seen in an earlier render node (3 mm epsilon catches small
  //         positional offsets DCS uses between overlapping render passes).
  if (opts?.deduplicateFaces !== false) {
    const epsilon = opts?.weldEpsilon ?? 3e-3; // 3 mm default (was 1 mm)
    result = deduplicateAcrossMeshes(result, epsilon);
  }

  // Pass 2: remove zero-area (degenerate) triangles.
  if (opts?.cleanMesh !== false) {
    result = removeDegenerateFaces(result);
  }

  // Pass 3: drop near-empty mesh fragments left over from near-duplicate render
  //         nodes.  If a mesh lost ≥ 95 % of its triangles to dedup AND has
  //         fewer than 20 triangles remaining it is almost certainly a ghost
  //         copy — remove it entirely.
  result = result.filter((bm, i) => {
    const remaining = bm.indices.length / 3;
    const original = originalTriCounts[i] ?? remaining;
    if (remaining < 20 && original > 0 && remaining / original < 0.05) return false;
    return remaining > 0;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Connected-component (island) splitter  +  vertex welding / face dedup
// ---------------------------------------------------------------------------

/**
 * Build a weld map: for every vertex in `positions`, find the canonical
 * representative vertex among all vertices that share the same quantised grid
 * cell.  Two vertices within `epsilon` metres of each other on every axis will
 * map to the same canonical index, so seam / boundary vertices that DCS
 * duplicates per render-node are correctly fused before the union-find runs.
 *
 * Returns an Int32Array `weld` where `weld[v]` is the canonical vertex index
 * for vertex v (always <= v).
 */
function buildWeldMap(
  positions: Float32Array,
  count: number,
  epsilon = 1e-3,
): Int32Array {
  const weld = new Int32Array(count);
  const inv = 1 / epsilon;
  // key → first vertex index seen at that cell
  const grid = new Map<string, number>();
  for (let v = 0; v < count; v++) {
    const qx = Math.round(positions[v * 3]! * inv);
    const qy = Math.round(positions[v * 3 + 1]! * inv);
    const qz = Math.round(positions[v * 3 + 2]! * inv);
    const key = `${qx},${qy},${qz}`;
    let rep = grid.get(key);
    if (rep === undefined) {
      grid.set(key, v);
      rep = v;
    }
    weld[v] = rep;
  }
  return weld;
}

/**
 * Remove triangles from each mesh whose three world-space positions (quantised
 * by epsilon) exactly match a triangle already seen in a previously processed
 * mesh.  This eliminates Z-fighting caused by DCS render nodes that overlap in
 * world space (e.g. hull surface appearing in both a base and a detail node).
 *
 * The pass is order-preserving and only deduplicates ACROSS meshes; within
 * a single mesh the index buffer is unchanged.
 */
function deduplicateAcrossMeshes(
  meshes: BakedMesh[],
  epsilon = 1e-3,
): BakedMesh[] {
  const inv = 1 / epsilon;
  const seenFaces = new Set<string>();
  const out: BakedMesh[] = [];

  for (const bm of meshes) {
    const triCount = Math.floor(bm.indices.length / 3);
    const keepTris: number[] = [];

    for (let t = 0; t < triCount; t++) {
      // Build a canonical, winding-order-independent key from quantised positions.
      const pts: string[] = [];
      for (let k = 0; k < 3; k++) {
        const vi = bm.indices[t * 3 + k]!;
        const qx = Math.round(bm.positions[vi * 3]! * inv);
        const qy = Math.round(bm.positions[vi * 3 + 1]! * inv);
        const qz = Math.round(bm.positions[vi * 3 + 2]! * inv);
        pts.push(`${qx}/${qy}/${qz}`);
      }
      pts.sort(); // sort to be winding-order agnostic
      const key = pts.join("|");

      if (!seenFaces.has(key)) {
        seenFaces.add(key);
        keepTris.push(t);
      }
    }

    if (keepTris.length === triCount) {
      out.push(bm); // nothing removed — return original object
      continue;
    }
    if (keepTris.length === 0) continue;

    const newIndices = new Uint32Array(keepTris.length * 3);
    for (let i = 0; i < keepTris.length; i++) {
      const t = keepTris[i]!;
      newIndices[i * 3] = bm.indices[t * 3]!;
      newIndices[i * 3 + 1] = bm.indices[t * 3 + 1]!;
      newIndices[i * 3 + 2] = bm.indices[t * 3 + 2]!;
    }
    out.push({ ...bm, indices: newIndices });
  }
  return out;
}

/**
 * Remove degenerate (zero-area) triangles from every mesh.
 *
 * A triangle is degenerate when:
 *   • Two or more of its vertices share the same world-space position
 *     (coincident vertices — the edge between them has zero length), OR
 *   • All three vertices are collinear (the cross product of any two edge
 *     vectors is the zero vector, giving zero area).
 *
 * These show up in Blender as isolated edge-loops and cause problems with
 * shading, Booleans, and mesh analysis tools.  We filter them by computing
 * the squared length of the cross product of the two edge vectors from the
 * first vertex; if it is below a tiny epsilon the triangle is dropped.
 *
 * Threshold: area² < 1e-14  ≡  area < 1e-7 m²  ≡  ~316 μm × 316 μm
 * This catches only truly degenerate geometry; real triangles in a DCS ship
 * model are orders of magnitude larger.
 */
function removeDegenerateFaces(meshes: BakedMesh[]): BakedMesh[] {
  return meshes.map((bm) => {
    const triCount = Math.floor(bm.indices.length / 3);
    const keepTris: number[] = [];

    for (let t = 0; t < triCount; t++) {
      const i0 = bm.indices[t * 3]!;
      const i1 = bm.indices[t * 3 + 1]!;
      const i2 = bm.indices[t * 3 + 2]!;

      const ax = bm.positions[i0 * 3]!;
      const ay = bm.positions[i0 * 3 + 1]!;
      const az = bm.positions[i0 * 3 + 2]!;

      // Edge vectors A→B and A→C
      const e1x = bm.positions[i1 * 3]! - ax;
      const e1y = bm.positions[i1 * 3 + 1]! - ay;
      const e1z = bm.positions[i1 * 3 + 2]! - az;
      const e2x = bm.positions[i2 * 3]! - ax;
      const e2y = bm.positions[i2 * 3 + 1]! - ay;
      const e2z = bm.positions[i2 * 3 + 2]! - az;

      // |cross(e1, e2)|² = (2 × area)²
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const area2 = nx * nx + ny * ny + nz * nz;

      if (area2 >= 1e-14) keepTris.push(t);
    }

    if (keepTris.length === triCount) return bm;
    if (keepTris.length === 0) return { ...bm, indices: new Uint32Array(0) };

    const newIndices = new Uint32Array(keepTris.length * 3);
    for (let i = 0; i < keepTris.length; i++) {
      const t = keepTris[i]!;
      newIndices[i * 3] = bm.indices[t * 3]!;
      newIndices[i * 3 + 1] = bm.indices[t * 3 + 1]!;
      newIndices[i * 3 + 2] = bm.indices[t * 3 + 2]!;
    }
    return { ...bm, indices: newIndices };
  });
}

/**
 * Split a single BakedMesh into multiple sub-meshes using angle-based edge
 * splitting.  Two triangles sharing an edge are placed in the same island only
 * when the dihedral angle between their face normals is LESS than
 * `sharpAngleDeg` (default 45°).  Edges meeting at a steeper angle act as
 * hard boundaries, so a dome, its flat mounting bracket, and a vertical wall
 * each become separate islands rather than one giant polygon soup.
 *
 * Position-based welding (weldEpsilon) ensures that seam vertices stored as
 * duplicate indices at identical XYZ positions still form connected islands.
 *
 * @param bm             Source mesh.
 * @param minTris        Islands with fewer triangles are merged into a
 *                       catch-all "misc" sub-mesh (default 1).
 * @param weldEpsilon    Grid cell size (metres) for position-based welding.
 * @param sharpAngleDeg  Dihedral angle that acts as a split boundary (0–180°).
 */
export function splitByIslands(
  bm: BakedMesh,
  minTris = 1,
  weldEpsilon = 1e-3,
  sharpAngleDeg = 45,
): BakedMesh[] {
  const triCount = Math.floor(bm.indices.length / 3);
  if (triCount === 0) return [];

  const weld = weldEpsilon > 0 ? buildWeldMap(bm.positions, bm.count, weldEpsilon) : null;
  const canonV = (v: number) => (weld ? weld[v]! : v);
  const pos = bm.positions;

  // ── Compute per-triangle face normals ────────────────────────────────────
  const faceNx = new Float32Array(triCount);
  const faceNy = new Float32Array(triCount);
  const faceNz = new Float32Array(triCount);

  for (let t = 0; t < triCount; t++) {
    const i0 = bm.indices[t * 3]!;
    const i1 = bm.indices[t * 3 + 1]!;
    const i2 = bm.indices[t * 3 + 2]!;
    const ax = pos[i0 * 3]!, ay = pos[i0 * 3 + 1]!, az = pos[i0 * 3 + 2]!;
    const ex = pos[i1 * 3]! - ax, ey = pos[i1 * 3 + 1]! - ay, ez = pos[i1 * 3 + 2]! - az;
    const fx = pos[i2 * 3]! - ax, fy = pos[i2 * 3 + 1]! - ay, fz = pos[i2 * 3 + 2]! - az;
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len > 1e-10) { nx /= len; ny /= len; nz /= len; }
    faceNx[t] = nx; faceNy[t] = ny; faceNz[t] = nz;
  }

  // ── Build edge → triangle adjacency (canonical vertex ids as key) ────────
  // Encode edge as a single Number: min(a,b)*(vCount+1) + max(a,b).
  // Safe for vertex counts up to ~3 million within JS MAX_SAFE_INTEGER.
  const N = bm.count + 1;
  const edgeMap = new Map<number, number[]>();

  for (let t = 0; t < triCount; t++) {
    const v0 = canonV(bm.indices[t * 3]!);
    const v1 = canonV(bm.indices[t * 3 + 1]!);
    const v2 = canonV(bm.indices[t * 3 + 2]!);
    const verts = [v0, v1, v2] as const;
    for (let k = 0; k < 3; k++) {
      const ea = verts[k]!;
      const eb = verts[(k + 1) % 3]!;
      const key = Math.min(ea, eb) * N + Math.max(ea, eb);
      let arr = edgeMap.get(key);
      if (!arr) { arr = []; edgeMap.set(key, arr); }
      arr.push(t);
    }
  }

  // ── Triangle-level Union-Find ─────────────────────────────────────────────
  const parent = new Int32Array(triCount);
  const rank = new Uint8Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;

  function find(x: number): number {
    while (parent[x]! !== x) { parent[x] = parent[parent[x]!]!; x = parent[x]!; }
    return x;
  }
  function unite(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    if (rank[ra]! < rank[rb]!) parent[ra] = rb;
    else if (rank[ra]! > rank[rb]!) parent[rb] = ra;
    else { parent[rb] = ra; rank[ra]!++; }
  }

  const cosThreshold = Math.cos(sharpAngleDeg * Math.PI / 180);

  for (const [, tris] of edgeMap) {
    if (tris.length < 2) continue;
    // Cap non-manifold edge fanout to avoid O(n²) on pathological geometry.
    const lim = Math.min(tris.length, 8);
    for (let i = 0; i < lim - 1; i++) {
      for (let j = i + 1; j < lim; j++) {
        const t0 = tris[i]!, t1 = tris[j]!;
        const dot = faceNx[t0]! * faceNx[t1]! + faceNy[t0]! * faceNy[t1]! + faceNz[t0]! * faceNz[t1]!;
        if (dot >= cosThreshold) unite(t0, t1);
      }
    }
  }

  // ── Group triangles by component root ────────────────────────────────────
  const compMap = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const root = find(t);
    let arr = compMap.get(root);
    if (!arr) { arr = []; compMap.set(root, arr); }
    arr.push(t);
  }

  // ── Build sub-meshes (largest first so part0 = dominant surface) ─────────
  const results: BakedMesh[] = [];
  const miscTris: number[] = [];
  let islandIdx = 0;

  const sorted = [...compMap.values()].sort((a, b) => b.length - a.length);

  for (const tris of sorted) {
    if (tris.length < minTris) {
      for (const t of tris) miscTris.push(t);
      continue;
    }
    const sub = buildSubMesh(bm, tris, `${bm.name}_part${islandIdx}`);
    sub.material = bm.material;
    results.push(sub);
    islandIdx++;
  }

  if (miscTris.length > 0) {
    const sub = buildSubMesh(bm, miscTris, `${bm.name}_misc`);
    sub.material = bm.material;
    results.push(sub);
  }

  return results.length > 0 ? results : [bm];
}

function buildSubMesh(bm: BakedMesh, triIndices: number[], name: string): BakedMesh {
  const vertRemap = new Map<number, number>();
  const newPos: number[] = [];
  const newNrm: number[] = [];
  const newUv: number[] = [];
  const newIdx: number[] = [];

  for (const t of triIndices) {
    for (let k = 0; k < 3; k++) {
      const oldV = bm.indices[t * 3 + k]!;
      let newV = vertRemap.get(oldV);
      if (newV === undefined) {
        newV = newPos.length / 3;
        vertRemap.set(oldV, newV);
        newPos.push(
          bm.positions[oldV * 3]!,
          bm.positions[oldV * 3 + 1]!,
          bm.positions[oldV * 3 + 2]!,
        );
        if (bm.normals) {
          newNrm.push(
            bm.normals[oldV * 3]!,
            bm.normals[oldV * 3 + 1]!,
            bm.normals[oldV * 3 + 2]!,
          );
        }
        if (bm.uvs) {
          newUv.push(bm.uvs[oldV * 2]!, bm.uvs[oldV * 2 + 1]!);
        }
      }
      newIdx.push(newV);
    }
  }

  const count = newPos.length / 3;
  const positions = new Float32Array(newPos);
  const normals = bm.normals ? new Float32Array(newNrm) : null;
  const uvs = bm.uvs ? new Float32Array(newUv) : null;
  const indices = new Uint32Array(newIdx);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < count; v++) {
    const px = positions[v * 3]!;
    const py = positions[v * 3 + 1]!;
    const pz = positions[v * 3 + 2]!;
    if (px < min[0]) min[0] = px;
    if (py < min[1]) min[1] = py;
    if (pz < min[2]) min[2] = pz;
    if (px > max[0]) max[0] = px;
    if (py > max[1]) max[1] = py;
    if (pz > max[2]) max[2] = pz;
  }

  return { name, positions, normals, uvs, indices, count, material: bm.material, bbox: { min, max } };
}

/**
 * Bake all render nodes and then:
 *   1. Optionally remove duplicate faces that appear in multiple render nodes
 *      (deduplicateFaces, default true).
 *   2. Split every mesh into connected-component islands using position-based
 *      vertex welding (weldEpsilon) so seam verts don't fragment islands.
 *
 * Returns a flat array of island sub-meshes ready for export.
 */
function bakeAllSplitIslands(
  parsed: ParsedEdmFile,
  opts?: ExportOptions,
  minTris = 100,
): BakedMesh[] {
  const epsilon = opts?.weldEpsilon ?? 3e-3;
  const sharpAngle = opts?.sharpAngleDeg ?? 45;

  // bakeAll already runs deduplicateAcrossMeshes and removeDegenerateFaces
  // (both default ON) so we just split the cleaned meshes into islands.
  const baked = bakeAll(parsed, opts);

  const result: BakedMesh[] = [];
  for (const bm of baked) {
    const islands = splitByIslands(bm, minTris, epsilon, sharpAngle);
    result.push(...islands);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Wavefront OBJ + MTL
// ---------------------------------------------------------------------------

export interface ObjExportResult {
  baseName: string;
  obj: string;
  mtl: string;
}

export interface ObjSplitResult {
  baseName: string;
  /** One OBJ string per render node (references the shared MTL file). */
  objects: Array<{ name: string; obj: string }>;
  mtl: string;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/** Diagnostic: return bbox of each render node after baking (no dedup). */
export function bakeAllDebug(
  parsed: ParsedEdmFile,
): Array<{ name: string; tris: number; min: number[]; max: number[]; centroid: number[] }> {
  const world = buildWorldMatrices(parsed);
  return parsed.renderNodes.map((rn) => {
    const mat = parsed.root.materials[rn.material];
    const bones = buildBoneWorldMatrices(rn, world);
    const bm = bakeRenderNode(rn, mat, bones);
    const cx = (bm.bbox.min[0] + bm.bbox.max[0]) / 2;
    const cy = (bm.bbox.min[1] + bm.bbox.max[1]) / 2;
    const cz = (bm.bbox.min[2] + bm.bbox.max[2]) / 2;
    return {
      name: rn.name || "(unnamed)",
      tris: Math.floor(rn.indexBuffer.data.length / 3),
      min: bm.bbox.min.map((v) => Math.round(v * 10) / 10),
      max: bm.bbox.max.map((v) => Math.round(v * 10) / 10),
      centroid: [
        Math.round(cx * 10) / 10,
        Math.round(cy * 10) / 10,
        Math.round(cz * 10) / 10,
      ],
    };
  });
}

export function exportObj(
  parsed: ParsedEdmFile,
  baseName = "model",
  opts?: ExportOptions & { splitIslands?: boolean; minIslandTris?: number },
): ObjExportResult {
  const baked = opts?.splitIslands
    ? bakeAllSplitIslands(parsed, opts, opts?.minIslandTris ?? 100)
    : bakeAll(parsed, opts);
  const lines: string[] = [];
  const mtlLines: string[] = [];

  lines.push(`# Exported from EDM File Inspector`);
  lines.push(`# Source format: DCS World EDM v${parsed.version}`);
  lines.push(`# RenderNodes: ${baked.length}`);
  lines.push(`mtllib ${baseName}.mtl`);
  lines.push("");

  const materialNames: string[] = parsed.root.materials.map((m, i) => {
    const display = safeName(m.name ?? m.material_name ?? `Material_${i}`);
    return `${display}_${i}`;
  });
  parsed.root.materials.forEach((m, i) => {
    const name = materialNames[i]!;
    mtlLines.push(`newmtl ${name}`);
    mtlLines.push(`Ka 1.000 1.000 1.000`);
    mtlLines.push(`Kd 1.000 1.000 1.000`);
    mtlLines.push(`Ks 0.100 0.100 0.100`);
    mtlLines.push(`Ns 16.0`);
    mtlLines.push(`d 1.0`);
    mtlLines.push(`illum 2`);
    const tex = m.textures?.find((t) => t.index === 0);
    if (tex?.name) mtlLines.push(`map_Kd ${safeName(tex.name)}.dds`);
    mtlLines.push("");
  });

  let vOff = 0;
  let vtOff = 0;
  let vnOff = 0;

  baked.forEach((bm, i) => {
    lines.push(`o ${bm.name}_${i}`);
    lines.push(`g ${bm.name}_${i}`);

    for (let v = 0; v < bm.count; v++) {
      lines.push(
        `v ${fmt(bm.positions[v * 3]!)} ${fmt(bm.positions[v * 3 + 1]!)} ${fmt(bm.positions[v * 3 + 2]!)}`,
      );
    }
    if (bm.uvs) {
      for (let v = 0; v < bm.count; v++) {
        lines.push(`vt ${fmt(bm.uvs[v * 2]!)} ${fmt(bm.uvs[v * 2 + 1]!)}`);
      }
    }
    if (bm.normals) {
      for (let v = 0; v < bm.count; v++) {
        lines.push(
          `vn ${fmt(bm.normals[v * 3]!)} ${fmt(bm.normals[v * 3 + 1]!)} ${fmt(bm.normals[v * 3 + 2]!)}`,
        );
      }
    }

    lines.push(`usemtl ${materialNames[bm.material]!}`);

    const triCount = Math.floor(bm.indices.length / 3);
    const hasUV = !!bm.uvs;
    const hasN = !!bm.normals;
    for (let t = 0; t < triCount; t++) {
      const a = bm.indices[t * 3]! + 1;
      const b = bm.indices[t * 3 + 1]! + 1;
      const c = bm.indices[t * 3 + 2]! + 1;
      const ix = (k: number) => {
        if (hasUV && hasN) return `${k + vOff}/${k + vtOff}/${k + vnOff}`;
        if (hasUV) return `${k + vOff}/${k + vtOff}`;
        if (hasN) return `${k + vOff}//${k + vnOff}`;
        return `${k + vOff}`;
      };
      lines.push(`f ${ix(a)} ${ix(b)} ${ix(c)}`);
    }

    lines.push("");
    vOff += bm.count;
    if (bm.uvs) vtOff += bm.count;
    if (bm.normals) vnOff += bm.count;
  });

  return { baseName, obj: lines.join("\n"), mtl: mtlLines.join("\n") };
}

/**
 * Export each render node as its own .obj file, sharing a single .mtl.
 * Returns one obj string per baked mesh plus a shared material library.
 */
export function exportObjSplit(
  parsed: ParsedEdmFile,
  baseName = "model",
  opts?: ExportOptions,
): ObjSplitResult {
  const baked = bakeAll(parsed, opts);
  const mtlLines: string[] = [];

  const materialNames: string[] = parsed.root.materials.map((m, i) => {
    const display = safeName(m.name ?? m.material_name ?? `Material_${i}`);
    return `${display}_${i}`;
  });

  parsed.root.materials.forEach((m, i) => {
    const name = materialNames[i]!;
    mtlLines.push(`newmtl ${name}`);
    mtlLines.push(`Ka 1.000 1.000 1.000`);
    mtlLines.push(`Kd 1.000 1.000 1.000`);
    mtlLines.push(`Ks 0.100 0.100 0.100`);
    mtlLines.push(`Ns 16.0`);
    mtlLines.push(`d 1.0`);
    mtlLines.push(`illum 2`);
    const tex = m.textures?.find((t) => t.index === 0);
    if (tex?.name) mtlLines.push(`map_Kd ${safeName(tex.name)}.dds`);
    mtlLines.push("");
  });

  const objects = baked.map((bm, i) => {
    const lines: string[] = [];
    const objFileName = `${baseName}.mtl`;
    lines.push(`# EDM render node ${i}: ${bm.name}`);
    lines.push(`mtllib ${objFileName}`);
    lines.push(`o ${bm.name}`);
    lines.push(`g ${bm.name}`);
    for (let v = 0; v < bm.count; v++) {
      lines.push(
        `v ${fmt(bm.positions[v * 3]!)} ${fmt(bm.positions[v * 3 + 1]!)} ${fmt(bm.positions[v * 3 + 2]!)}`,
      );
    }
    if (bm.uvs) {
      for (let v = 0; v < bm.count; v++) {
        lines.push(`vt ${fmt(bm.uvs[v * 2]!)} ${fmt(bm.uvs[v * 2 + 1]!)}`);
      }
    }
    if (bm.normals) {
      for (let v = 0; v < bm.count; v++) {
        lines.push(
          `vn ${fmt(bm.normals[v * 3]!)} ${fmt(bm.normals[v * 3 + 1]!)} ${fmt(bm.normals[v * 3 + 2]!)}`,
        );
      }
    }
    lines.push(`usemtl ${materialNames[bm.material]!}`);
    const triCount = Math.floor(bm.indices.length / 3);
    const hasUV = !!bm.uvs;
    const hasN = !!bm.normals;
    for (let t = 0; t < triCount; t++) {
      const a = bm.indices[t * 3]! + 1;
      const b = bm.indices[t * 3 + 1]! + 1;
      const c = bm.indices[t * 3 + 2]! + 1;
      const ix = (k: number) => {
        if (hasUV && hasN) return `${k}/${k}/${k}`;
        if (hasUV) return `${k}/${k}`;
        if (hasN) return `${k}//${k}`;
        return `${k}`;
      };
      lines.push(`f ${ix(a)} ${ix(b)} ${ix(c)}`);
    }
    return { name: `${bm.name}_${i}.obj`, obj: lines.join("\n") };
  });

  return { baseName, objects, mtl: mtlLines.join("\n") };
}

// ---------------------------------------------------------------------------
// glTF 2.0 binary (.glb)
// ---------------------------------------------------------------------------

interface GltfBufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  target?: number;
}
interface GltfAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: "SCALAR" | "VEC2" | "VEC3" | "VEC4";
  min?: number[];
  max?: number[];
}

const GL_FLOAT = 5126;
const GL_UNSIGNED_SHORT = 5123;
const GL_UNSIGNED_INT = 5125;
const GL_ARRAY_BUFFER = 34962;
const GL_ELEMENT_ARRAY_BUFFER = 34963;

export function exportGlb(
  parsed: ParsedEdmFile,
  opts?: ExportOptions & { splitIslands?: boolean; minIslandTris?: number },
): Buffer {
  const baked = opts?.splitIslands
    ? bakeAllSplitIslands(parsed, opts, opts?.minIslandTris ?? 100)
    : bakeAll(parsed, opts);

  const bufferViews: GltfBufferView[] = [];
  const accessors: GltfAccessor[] = [];
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  const sceneNodes: number[] = [];
  const materials: unknown[] = [];
  const textures: unknown[] = [];
  const images: unknown[] = [];
  const samplers: unknown[] = [{}];

  const textureNameToIndex = new Map<string, number>();
  const addTexture = (name: string): number => {
    if (textureNameToIndex.has(name)) return textureNameToIndex.get(name)!;
    const idx = textures.length;
    images.push({ uri: `${safeName(name)}.dds` });
    textures.push({ source: idx, sampler: 0 });
    textureNameToIndex.set(name, idx);
    return idx;
  };

  parsed.root.materials.forEach((m, i) => {
    const tex = m.textures?.find((t) => t.index === 0);
    const baseColorTex = tex?.name ? addTexture(tex.name) : undefined;
    materials.push({
      name: m.name ?? m.material_name ?? `Material_${i}`,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 0.8,
        ...(baseColorTex !== undefined
          ? { baseColorTexture: { index: baseColorTex } }
          : {}),
      },
      doubleSided: true,
    });
  });

  const binChunks: Buffer[] = [];
  let binOffset = 0;
  const pushView = (buf: Buffer, target?: number): number => {
    const pad = (4 - (binOffset % 4)) % 4;
    if (pad) {
      binChunks.push(Buffer.alloc(pad));
      binOffset += pad;
    }
    const view: GltfBufferView = {
      buffer: 0,
      byteOffset: binOffset,
      byteLength: buf.length,
    };
    if (target !== undefined) view.target = target;
    bufferViews.push(view);
    binChunks.push(buf);
    binOffset += buf.length;
    return bufferViews.length - 1;
  };

  baked.forEach((bm, i) => {
    const posBV = pushView(
      Buffer.from(
        bm.positions.buffer,
        bm.positions.byteOffset,
        bm.positions.byteLength,
      ),
      GL_ARRAY_BUFFER,
    );
    accessors.push({
      bufferView: posBV,
      componentType: GL_FLOAT,
      count: bm.count,
      type: "VEC3",
      min: bm.bbox.min,
      max: bm.bbox.max,
    });
    const posAcc = accessors.length - 1;

    let nrmAcc: number | undefined;
    if (bm.normals) {
      const bv = pushView(
        Buffer.from(
          bm.normals.buffer,
          bm.normals.byteOffset,
          bm.normals.byteLength,
        ),
        GL_ARRAY_BUFFER,
      );
      accessors.push({
        bufferView: bv,
        componentType: GL_FLOAT,
        count: bm.count,
        type: "VEC3",
      });
      nrmAcc = accessors.length - 1;
    }

    let uvAcc: number | undefined;
    if (bm.uvs) {
      const bv = pushView(
        Buffer.from(bm.uvs.buffer, bm.uvs.byteOffset, bm.uvs.byteLength),
        GL_ARRAY_BUFFER,
      );
      accessors.push({
        bufferView: bv,
        componentType: GL_FLOAT,
        count: bm.count,
        type: "VEC2",
      });
      uvAcc = accessors.length - 1;
    }

    const maxIdx = bm.count - 1;
    let idxBuf: Buffer;
    let idxComp: number;
    if (maxIdx < 65536) {
      const arr = new Uint16Array(bm.indices.length);
      for (let k = 0; k < bm.indices.length; k++) arr[k] = bm.indices[k]!;
      idxBuf = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
      idxComp = GL_UNSIGNED_SHORT;
    } else {
      idxBuf = Buffer.from(
        bm.indices.buffer,
        bm.indices.byteOffset,
        bm.indices.byteLength,
      );
      idxComp = GL_UNSIGNED_INT;
    }
    const idxBV = pushView(idxBuf, GL_ELEMENT_ARRAY_BUFFER);
    accessors.push({
      bufferView: idxBV,
      componentType: idxComp,
      count: bm.indices.length,
      type: "SCALAR",
    });
    const idxAcc = accessors.length - 1;

    const attributes: Record<string, number> = { POSITION: posAcc };
    if (nrmAcc !== undefined) attributes["NORMAL"] = nrmAcc;
    if (uvAcc !== undefined) attributes["TEXCOORD_0"] = uvAcc;

    meshes.push({
      name: `${bm.name}_${i}`,
      primitives: [
        { attributes, indices: idxAcc, material: bm.material, mode: 4 },
      ],
    });
    nodes.push({ mesh: i, name: `${bm.name}_${i}` });
    sceneNodes.push(i);
  });

  const binBody = Buffer.concat(binChunks);
  const binPad = (4 - (binBody.length % 4)) % 4;
  const paddedBin = binPad
    ? Buffer.concat([binBody, Buffer.alloc(binPad)])
    : binBody;

  const gltf = {
    asset: {
      version: "2.0",
      generator: `EDM File Inspector (DCS EDM v${parsed.version})`,
    },
    scene: 0,
    scenes: [{ nodes: sceneNodes }],
    nodes,
    meshes,
    materials,
    ...(textures.length ? { textures, images, samplers } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: paddedBin.length }],
  };

  let jsonStr = JSON.stringify(gltf);
  const jsonPad = (4 - (Buffer.byteLength(jsonStr, "utf8") % 4)) % 4;
  if (jsonPad) jsonStr += " ".repeat(jsonPad);
  const jsonBuf = Buffer.from(jsonStr, "utf8");

  const totalLen = 12 + 8 + jsonBuf.length + 8 + paddedBin.length;
  const out = Buffer.alloc(totalLen);
  let p = 0;
  out.write("glTF", p); p += 4;
  out.writeUInt32LE(2, p); p += 4;
  out.writeUInt32LE(totalLen, p); p += 4;
  out.writeUInt32LE(jsonBuf.length, p); p += 4;
  out.write("JSON", p); p += 4;
  jsonBuf.copy(out, p); p += jsonBuf.length;
  out.writeUInt32LE(paddedBin.length, p); p += 4;
  out.write("BIN\0", p); p += 4;
  paddedBin.copy(out, p);

  return out;
}

// ---------------------------------------------------------------------------
// FBX 7.4 Binary
// ---------------------------------------------------------------------------

/**
 * Convert one render node into FBX `Geometry` + `Model` nodes.
 *
 * Layout:
 *   - One Geometry + one Model per render node
 *   - Normals  → ByVertice / Direct (one normal per vertex)
 *   - UVs      → ByVertice / Direct
 *   - Materials → AllSame (each render node uses exactly one material)
 *   - Triangles only; per FBX convention the last index of each polygon is
 *     bitwise-NOT'd (`~c` == `-(c + 1)`) to mark the polygon boundary.
 */
function buildFbxGeometry(
  bm: BakedMesh,
  geomId: bigint,
  modelId: bigint,
  objName: string,
): FbxNode[] {
  // Vertices (Float64)
  const positions64 = Float64Array.from(bm.positions);

  // PolygonVertexIndex with end-of-polygon marker
  const triCount = Math.floor(bm.indices.length / 3);
  const pvi = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    pvi[t * 3] = bm.indices[t * 3]!;
    pvi[t * 3 + 1] = bm.indices[t * 3 + 1]!;
    pvi[t * 3 + 2] = ~bm.indices[t * 3 + 2]!; // bitwise-NOT == -(c+1)
  }

  const geomChildren: FbxNode[] = [
    N("Properties70"),
    N("GeometryVersion", [I(124)]),
    N("Vertices", [dArr(positions64)]),
    N("PolygonVertexIndex", [{ type: "i", value: pvi }]),
  ];

  if (bm.normals) {
    const n64 = Float64Array.from(bm.normals);
    geomChildren.push(
      N(
        "LayerElementNormal",
        [I(0)],
        [
          N("Version", [I(102)]),
          N("Name", [S("")]),
          N("MappingInformationType", [S("ByVertice")]),
          N("ReferenceInformationType", [S("Direct")]),
          N("Normals", [dArr(n64)]),
          N(
            "NormalsW",
            [dArr(new Float64Array(bm.count).fill(0))], // present in real Autodesk files
          ),
        ],
      ),
    );
  }
  if (bm.uvs) {
    const uv64 = Float64Array.from(bm.uvs);
    geomChildren.push(
      N(
        "LayerElementUV",
        [I(0)],
        [
          N("Version", [I(101)]),
          N("Name", [S("UVMap")]),
          N("MappingInformationType", [S("ByVertice")]),
          N("ReferenceInformationType", [S("Direct")]),
          N("UV", [dArr(uv64)]),
        ],
      ),
    );
  }
  geomChildren.push(
    N(
      "LayerElementMaterial",
      [I(0)],
      [
        N("Version", [I(101)]),
        N("Name", [S("")]),
        N("MappingInformationType", [S("AllSame")]),
        N("ReferenceInformationType", [S("IndexToDirect")]),
        N("Materials", [iArr([0])]),
      ],
    ),
  );
  const layerElems: FbxNode[] = [];
  if (bm.normals) {
    layerElems.push(
      N("LayerElement", [], [
        N("Type", [S("LayerElementNormal")]),
        N("TypedIndex", [I(0)]),
      ]),
    );
  }
  layerElems.push(
    N("LayerElement", [], [
      N("Type", [S("LayerElementMaterial")]),
      N("TypedIndex", [I(0)]),
    ]),
  );
  if (bm.uvs) {
    layerElems.push(
      N("LayerElement", [], [
        N("Type", [S("LayerElementUV")]),
        N("TypedIndex", [I(0)]),
      ]),
    );
  }
  geomChildren.push(N("Layer", [I(0)], [N("Version", [I(100)]), ...layerElems]));

  return [
    N(
      "Geometry",
      [L(geomId), S(objId(objName, "Geometry")), S("Mesh")],
      geomChildren,
    ),
    N(
      "Model",
      [L(modelId), S(objId(objName, "Model")), S("Mesh")],
      [
        N("Version", [I(232)]),
        N(
          "Properties70",
          [],
          [
            P("RotationActive", "bool", "", "", I(1)),
            P("InheritType", "enum", "", "", I(1)),
            P("ScalingMax", "Vector3D", "Vector", "", D(0), D(0), D(0)),
            P("DefaultAttributeIndex", "int", "Integer", "", I(0)),
            P("Lcl Translation", "Lcl Translation", "", "A", D(0), D(0), D(0)),
            P("Lcl Rotation", "Lcl Rotation", "", "A", D(0), D(0), D(0)),
            P("Lcl Scaling", "Lcl Scaling", "", "A", D(1), D(1), D(1)),
          ],
        ),
        N("Shading", [C(true)]),
        N("Culling", [S("CullingOff")]),
      ],
    ),
  ];
}


/**
 * Build a complete FBX 7.4 **binary** document from the parsed EDM tree.
 *
 * Why binary: Blender flatly rejects FBX ASCII ("ASCII FBX files are not
 * supported"), and modern DCC tools all prefer binary anyway — it round-trips
 * with full precision and is 5–10× smaller on disk than the ASCII form.
 */
export function exportFbxBinary(
  parsed: ParsedEdmFile,
  baseName = "model",
  opts?: ExportOptions,
): Buffer {
  const baked = bakeAll(parsed, opts).filter(
    (bm) => bm.count > 0 && bm.indices.length >= 3,
  );

  // Stable IDs — start high enough not to collide with the well-known root id 0.
  let nextId = 1000n;
  const newId = (): bigint => ++nextId;

  const matIds: bigint[] = parsed.root.materials.map(() => newId());
  const meshIds = baked.map(() => ({ geom: newId(), model: newId() }));
  const textureIds = new Map<string, { tex: bigint; video: bigint }>();

  const ts = new Date();

  // -- FBXHeaderExtension --
  const headerExt = N(
    "FBXHeaderExtension",
    [],
    [
      N("FBXHeaderVersion", [I(1003)]),
      N("FBXVersion", [I(7400)]),
      N(
        "CreationTimeStamp",
        [],
        [
          N("Version", [I(1000)]),
          N("Year", [I(ts.getUTCFullYear())]),
          N("Month", [I(ts.getUTCMonth() + 1)]),
          N("Day", [I(ts.getUTCDate())]),
          N("Hour", [I(ts.getUTCHours())]),
          N("Minute", [I(ts.getUTCMinutes())]),
          N("Second", [I(ts.getUTCSeconds())]),
          N("Millisecond", [I(ts.getUTCMilliseconds())]),
        ],
      ),
      N("Creator", [S(`EDM File Inspector (DCS EDM v${parsed.version})`)]),
      N(
        "SceneInfo",
        [S(objId("SceneInfo", "GlobalInfo")), S("UserData")],
        [
          N("Type", [S("UserData")]),
          N("Version", [I(100)]),
          N(
            "MetaData",
            [],
            [
              N("Version", [I(100)]),
              N("Title", [S(baseName)]),
              N("Subject", [S("")]),
              N("Author", [S("")]),
              N("Keywords", [S("DCS EDM")]),
              N("Revision", [S("")]),
              N("Comment", [S("")]),
            ],
          ),
        ],
      ),
    ],
  );

  // -- GlobalSettings (Y-up, meters) --
  const globalSettings = N(
    "GlobalSettings",
    [],
    [
      N("Version", [I(1000)]),
      N(
        "Properties70",
        [],
        [
          P("UpAxis", "int", "Integer", "", I(1)),
          P("UpAxisSign", "int", "Integer", "", I(1)),
          P("FrontAxis", "int", "Integer", "", I(2)),
          P("FrontAxisSign", "int", "Integer", "", I(1)),
          P("CoordAxis", "int", "Integer", "", I(0)),
          P("CoordAxisSign", "int", "Integer", "", I(1)),
          P("OriginalUpAxis", "int", "Integer", "", I(-1)),
          P("OriginalUpAxisSign", "int", "Integer", "", I(1)),
          P("UnitScaleFactor", "double", "Number", "", D(1)),
          P("OriginalUnitScaleFactor", "double", "Number", "", D(1)),
          P("AmbientColor", "ColorRGB", "Color", "", D(0), D(0), D(0)),
          P("DefaultCamera", "KString", "", "", S("Producer Perspective")),
          P("TimeMode", "enum", "", "", I(11)),
          P("TimeProtocol", "enum", "", "", I(2)),
        ],
      ),
    ],
  );

  // -- Documents --
  const documents = N(
    "Documents",
    [],
    [
      N("Count", [I(1)]),
      N(
        "Document",
        [L(1n), S(""), S("Scene")],
        [
          N(
            "Properties70",
            [],
            [
              P("SourceObject", "object", "", ""),
              P("ActiveAnimStackName", "KString", "", "", S("")),
            ],
          ),
          N("RootNode", [L(0n)]),
        ],
      ),
    ],
  );

  // -- References / Definitions --
  const references = N("References");

  const definitions = N(
    "Definitions",
    [],
    [
      N("Version", [I(100)]),
      N("Count", [I(5)]),
      N("ObjectType", [S("GlobalSettings")], [N("Count", [I(1)])]),
      N(
        "ObjectType",
        [S("Geometry")],
        [
          N("Count", [I(baked.length)]),
          N(
            "PropertyTemplate",
            [S("FbxMesh")],
            [N("Properties70")],
          ),
        ],
      ),
      N(
        "ObjectType",
        [S("Model")],
        [
          N("Count", [I(baked.length)]),
          N(
            "PropertyTemplate",
            [S("FbxNode")],
            [
              N(
                "Properties70",
                [],
                [
                  P("ScalingMax", "Vector3D", "Vector", "", D(0), D(0), D(0)),
                  P("DefaultAttributeIndex", "int", "Integer", "", I(-1)),
                  P("InheritType", "enum", "", "", I(1)),
                ],
              ),
            ],
          ),
        ],
      ),
      N(
        "ObjectType",
        [S("Material")],
        [
          N("Count", [I(parsed.root.materials.length)]),
          N(
            "PropertyTemplate",
            [S("FbxSurfacePhong")],
            [
              N(
                "Properties70",
                [],
                [
                  P("ShadingModel", "KString", "", "", S("Phong")),
                  P("MultiLayer", "bool", "", "", I(0)),
                ],
              ),
            ],
          ),
        ],
      ),
      // Texture/Video templates — always emit them for forward-compatibility,
      // even if the model uses no textures.
      N(
        "ObjectType",
        [S("Texture")],
        [
          N("Count", [I(0)]),
          N(
            "PropertyTemplate",
            [S("FbxFileTexture")],
            [N("Properties70")],
          ),
        ],
      ),
      N(
        "ObjectType",
        [S("Video")],
        [
          N("Count", [I(0)]),
          N(
            "PropertyTemplate",
            [S("FbxVideo")],
            [N("Properties70")],
          ),
        ],
      ),
    ],
  );

  // -- Objects --
  const objectChildren: FbxNode[] = [];

  baked.forEach((bm, i) => {
    const ids = meshIds[i]!;
    const objName = `${bm.name}_${i}`;
    objectChildren.push(...buildFbxGeometry(bm, ids.geom, ids.model, objName));
  });

  parsed.root.materials.forEach((m, i) => {
    const id = matIds[i]!;
    const display = safeName(m.name ?? m.material_name ?? `Material_${i}`);
    objectChildren.push(
      N(
        "Material",
        [L(id), S(objId(`${display}_${i}`, "Material")), S("")],
        [
          N("Version", [I(102)]),
          N("ShadingModel", [S("Phong")]),
          N("MultiLayer", [I(0)]),
          N(
            "Properties70",
            [],
            [
              P("AmbientColor", "Color", "", "A", D(0.1), D(0.1), D(0.1)),
              P("DiffuseColor", "Color", "", "A", D(0.8), D(0.8), D(0.8)),
              P("DiffuseFactor", "Number", "", "A", D(1)),
              P("SpecularColor", "Color", "", "A", D(0.2), D(0.2), D(0.2)),
              P("SpecularFactor", "Number", "", "A", D(0.2)),
              P("ShininessExponent", "Number", "", "A", D(20)),
              P("Opacity", "Number", "", "A", D(1)),
            ],
          ),
        ],
      ),
    );

    const tex = m.textures?.find((t) => t.index === 0);
    if (tex?.name) {
      let pair = textureIds.get(tex.name);
      if (!pair) {
        pair = { tex: newId(), video: newId() };
        textureIds.set(tex.name, pair);
        const fileName = `${safeName(tex.name)}.dds`;
        const cleanTexName = safeName(tex.name);
        const videoIdStr = objId(cleanTexName, "Video");
        const textureIdStr = objId(cleanTexName, "Texture");
        objectChildren.push(
          N(
            "Video",
            [L(pair.video), S(videoIdStr), S("Clip")],
            [
              N("Type", [S("Clip")]),
              N(
                "Properties70",
                [],
                [P("Path", "KString", "XRefUrl", "", S(fileName))],
              ),
              N("UseMipMap", [I(0)]),
              N("Filename", [S(fileName)]),
              N("RelativeFilename", [S(fileName)]),
            ],
          ),
        );
        objectChildren.push(
          N(
            "Texture",
            [L(pair.tex), S(textureIdStr), S("")],
            [
              N("Type", [S("TextureVideoClip")]),
              N("Version", [I(202)]),
              N("TextureName", [S(textureIdStr)]),
              N(
                "Properties70",
                [],
                [
                  P("UVSet", "KString", "", "", S("UVMap")),
                  P("UseMaterial", "bool", "", "", I(1)),
                ],
              ),
              N("Media", [S(videoIdStr)]),
              N("FileName", [S(fileName)]),
              N("RelativeFilename", [S(fileName)]),
              N("ModelUVTranslation", [D(0), D(0)]),
              N("ModelUVScaling", [D(1), D(1)]),
              N("Texture_Alpha_Source", [S("None")]),
              N("Cropping", [I(0), I(0), I(0), I(0)]),
            ],
          ),
        );
      }
    }
  });

  const objects = N("Objects", [], objectChildren);

  // -- Connections --
  const connChildren: FbxNode[] = [];
  baked.forEach((bm, i) => {
    const ids = meshIds[i]!;
    connChildren.push(N("C", [S("OO"), L(ids.geom), L(ids.model)]));
    connChildren.push(N("C", [S("OO"), L(ids.model), L(0n)]));
    const matId = matIds[bm.material];
    if (matId !== undefined) {
      connChildren.push(N("C", [S("OO"), matId ? L(matId) : L(0n), L(ids.model)]));
    }
  });
  parsed.root.materials.forEach((m, i) => {
    const tex = m.textures?.find((t) => t.index === 0);
    if (!tex?.name) return;
    const pair = textureIds.get(tex.name);
    if (!pair) return;
    const matId = matIds[i]!;
    connChildren.push(N("C", [S("OO"), L(pair.video), L(pair.tex)]));
    connChildren.push(
      N("C", [S("OP"), L(pair.tex), L(matId), S("DiffuseColor")]),
    );
  });
  const connections = N("Connections", [], connChildren);

  const takes = N("Takes", [], [N("Current", [S("")])]);

  return encodeFbxBinary([
    headerExt,
    globalSettings,
    documents,
    references,
    definitions,
    objects,
    connections,
    takes,
  ]);
}
