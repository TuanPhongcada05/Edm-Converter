/**
 * Mesh decimation (triangle reduction) using meshoptimizer.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Core algorithm: tiered size-aware budget allocation
 * ─────────────────────────────────────────────────────────────────────────
 *
 * DCS World models like Tarantul/Petya are dominated by a small number of
 * very large render nodes (hull plates, deck surfaces — "huge" meshes with
 * ≥ 3 000 triangles) that together hold 95–99 % of all triangles.  The
 * remaining render nodes are small detail meshes: railings, bollards, weapon
 * mounts, radar housings, aerials — each with < 3 000 triangles.
 *
 * A uniform-ratio algorithm that cuts every mesh by the same fraction
 * destroys these detail meshes while barely denting the huge ones.
 *
 * The tiered algorithm instead:
 *
 *   1. ALWAYS keep small/medium/large meshes (< HUGE_THRESH tris) at their
 *      best possible quality (ideally 100 %, never below a per-tier floor).
 *   2. Compute how many triangles are left for the huge meshes:
 *        hugeBudget = max(hugeTotal × HUGE_FLOOR, budgetTris − nonHugeKept)
 *   3. Reduce every huge mesh uniformly to hugeRatio = hugeBudget / hugeTotal.
 *
 * Result for a 200 k budget on a 1.13 M-tri Tarantul:
 *   • Non-huge (20 meshes, 15 913 tris) — kept at 100 %
 *   • Huge     ( 8 meshes, 1 114 386 tris) — ratio ≈ 16.5 %
 *   Total ≈ 200 k, all detail parts fully preserved.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Mesh integrity: LockBorder
 * ─────────────────────────────────────────────────────────────────────────
 * DCS render nodes sit next to each other in world space and share seam
 * vertices — the boundary edges of one panel align precisely with those of
 * its neighbour.  Without LockBorder the simplifier collapses those boundary
 * vertices, breaking the seam and producing visible holes in the exported
 * model.  LockBorder prevents this by pinning every boundary edge.
 *
 * Flat hull panels benefit the most: their interior can be collapsed freely
 * while the perimeter stays locked, giving large triangle reductions with
 * zero shape distortion.  Curved surfaces (radars, gun barrels) reduce less
 * but their silhouette is preserved exactly.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Two-pass simplification
 * ─────────────────────────────────────────────────────────────────────────
 * If the first pass stops far short of the target (because LockBorder pins
 * many boundary vertices), a second pass runs on the reduced output with a
 * slightly higher error tolerance, helping boundary-heavy panels reach their
 * target without touching quality-sensitive meshes.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Error tolerance tiers (based on per-mesh ratio, not global ratio)
 * ─────────────────────────────────────────────────────────────────────────
 *   ratio ≥ 0.60  →  3 %   (mild   — shapes stay nearly identical)
 *   ratio ≥ 0.40  →  5 %   (light)
 *   ratio ≥ 0.20  →  8 %   (moderate)
 *   ratio  < 0.20  → 12 %  (aggressive — needed to reach low budgets)
 *
 * Flat surfaces hit the target with essentially 0 % error regardless, so
 * higher tolerances only affect curved geometry — and even at 12 % most
 * curved parts remain recognisable.
 */
import { MeshoptSimplifier } from "meshoptimizer";

let readyPromise: Promise<void> | null = null;

export async function ensureSimplifierReady(): Promise<void> {
  if (!readyPromise) readyPromise = MeshoptSimplifier.ready;
  await readyPromise;
}

export interface BakedMeshLike {
  positions: Float32Array;
  indices: Uint32Array;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Skip meshes smaller than this — QEM error estimation is unreliable below it. */
const MIN_ELIGIBLE_TRIS = 32;

/**
 * Triangle count at or above which a mesh is classified as "huge" and treated
 * as a candidate for aggressive budget reduction.  Below this threshold meshes
 * are detail parts and are protected.
 */
const HUGE_THRESH = 3_000;

/** Absolute minimum ratio for huge meshes — never reduce below 5 %. */
const HUGE_FLOOR = 0.05;

/** Per-tier minimum keep-ratios for non-huge meshes. */
const NON_HUGE_FLOORS: Array<{ maxTris: number; floor: number }> = [
  { maxTris: 31,       floor: 1.00 }, // tiny  : always keep
  { maxTris: 149,      floor: 0.85 }, // small : keep ≥ 85 %
  { maxTris: 599,      floor: 0.65 }, // medium: keep ≥ 65 %
  { maxTris: 2_999,    floor: 0.40 }, // large : keep ≥ 40 %
];

const FLAGS: Parameters<typeof MeshoptSimplifier.simplify>[5] = [
  "LockBorder", // pin seam vertices → no holes between adjacent render nodes
  "Prune",      // drop disconnected micro-fragments that have no locked edges
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function adaptiveError(ratio: number): number {
  if (ratio >= 0.60) return 0.03;
  if (ratio >= 0.40) return 0.05;
  if (ratio >= 0.20) return 0.08;
  return 0.12;
}

function nonHugeFloor(tris: number): number {
  for (const { maxTris, floor } of NON_HUGE_FLOORS) {
    if (tris <= maxTris) return floor;
  }
  return 0.40;
}

/**
 * Clamp a user-supplied ratio (0..1) to [0.01, 1].
 * Values ≥ 0.999 are treated as "no decimation" by callers.
 */
export function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 1;
  if (ratio <= 0.01) return 0.01;
  if (ratio >= 1) return 1;
  return ratio;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core simplify helper — two-pass with adaptive error
// ─────────────────────────────────────────────────────────────────────────────

function runSimplify(
  positions: Float32Array,
  indices: Uint32Array,
  meshRatio: number,
  errorTolerance: number,
): Uint32Array {
  const origTris = indices.length / 3;
  const targetTris = Math.max(8, Math.floor(origTris * meshRatio));
  const targetCount = targetTris * 3;
  if (targetCount >= indices.length) return indices;

  const [pass1] = MeshoptSimplifier.simplify(
    indices,
    positions,
    3,
    targetCount,
    errorTolerance,
    FLAGS,
  );

  if (pass1.length < 3) return indices;

  // If the first pass landed within 50 % of the target we're done.
  // If it stopped far short (heavy LockBorder restriction on boundary-heavy
  // meshes), run a second pass on the reduced output with up to 2× the
  // tolerance (capped at 20 %) to push closer to target.
  if (pass1.length <= targetCount * 1.5) return pass1;

  const looserError = Math.min(0.20, errorTolerance * 2);
  const [pass2] = MeshoptSimplifier.simplify(
    pass1,
    positions,
    3,
    targetCount,
    looserError,
    FLAGS,
  );

  return pass2.length >= 3 ? pass2 : pass1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reduce a single mesh's index buffer toward `ratio × originalTris`.
 * Mesh vertex / normal / UV arrays are not touched.
 */
export function simplifyIndices(
  positions: Float32Array,
  indices: Uint32Array,
  ratio: number,
): Uint32Array {
  const r = clampRatio(ratio);
  if (r >= 0.999) return indices;
  if (indices.length / 3 < MIN_ELIGIBLE_TRIS) return indices;
  return runSimplify(positions, indices, r, adaptiveError(r));
}

/**
 * Distribute a global triangle budget across all meshes using a
 * size-aware tiered strategy that preserves detail meshes.
 *
 * Strategy (3 scenarios, tried in order of quality):
 *
 *   A — IDEAL: Keep all non-huge meshes at 100 %.
 *       Budget remaining goes to huge meshes.
 *       Used when hugeBudget ≥ hugeTotal × HUGE_FLOOR.
 *
 *   B — FALLBACK: Apply per-tier floor ratios to non-huge meshes.
 *       Budget remaining (above floors) goes to huge meshes.
 *       Used when scenario A would push huge meshes below their floor.
 *
 *   C — LAST RESORT: Model is so large that even at all floors we exceed
 *       the budget. Scale all ratios uniformly with floors as hard minimums.
 */
export function applyGlobalBudget(
  meshes: BakedMeshLike[],
  budgetTris: number,
): Uint32Array[] {
  const triCounts = meshes.map((m) => m.indices.length / 3);
  const totalTris = triCounts.reduce((s, t) => s + t, 0);

  if (totalTris <= budgetTris) return meshes.map((m) => m.indices);

  // Split meshes into "huge" (candidates for heavy reduction) and "non-huge"
  // (detail parts, protected as much as the budget allows).
  const isHuge = triCounts.map((t) => t >= HUGE_THRESH);
  const nonHugeTotal = triCounts.reduce((s, t, i) => (isHuge[i] ? s : s + t), 0);
  const hugeTotal    = triCounts.reduce((s, t, i) => (isHuge[i] ? s + t : s), 0);

  // ── Scenario A: keep every non-huge mesh at 100 % ─────────────────────────
  const scenarioAHugeBudget = budgetTris - nonHugeTotal;
  const scenarioAHugeRatio  = hugeTotal > 0
    ? scenarioAHugeBudget / hugeTotal
    : 1;

  if (scenarioAHugeRatio >= HUGE_FLOOR) {
    return meshes.map((mesh, i) => {
      const t = triCounts[i]!;
      if (!isHuge[i]) return mesh.indices;            // keep non-huge intact
      if (t < MIN_ELIGIBLE_TRIS) return mesh.indices;
      const ratio = Math.min(1, scenarioAHugeRatio);
      return runSimplify(mesh.positions, mesh.indices, ratio, adaptiveError(ratio));
    });
  }

  // ── Scenario B: apply tier floors to non-huge, huge gets remaining ─────────
  const nonHugeFloorTris = triCounts.reduce((s, t, i) => {
    if (isHuge[i]) return s;
    return s + Math.ceil(t * nonHugeFloor(t));
  }, 0);
  const scenarioBHugeBudget = Math.max(
    hugeTotal * HUGE_FLOOR,
    budgetTris - nonHugeFloorTris,
  );
  const scenarioBHugeRatio = hugeTotal > 0
    ? Math.min(1, scenarioBHugeBudget / hugeTotal)
    : 1;

  if (nonHugeFloorTris <= budgetTris) {
    return meshes.map((mesh, i) => {
      const t = triCounts[i]!;
      if (t < MIN_ELIGIBLE_TRIS) return mesh.indices;

      if (isHuge[i]) {
        const ratio = Math.max(HUGE_FLOOR, scenarioBHugeRatio);
        return runSimplify(mesh.positions, mesh.indices, ratio, adaptiveError(ratio));
      }

      const floor = nonHugeFloor(t);
      if (floor >= 0.999) return mesh.indices;
      return runSimplify(mesh.positions, mesh.indices, floor, adaptiveError(floor));
    });
  }

  // ── Scenario C: everything is still too large — uniform scale with floors ──
  const globalRatio = budgetTris / totalTris;
  return meshes.map((mesh, i) => {
    const t = triCounts[i]!;
    if (t < MIN_ELIGIBLE_TRIS) return mesh.indices;

    const floor = isHuge[i] ? HUGE_FLOOR : nonHugeFloor(t);
    const ratio = Math.max(floor, globalRatio);
    if (ratio >= 0.999) return mesh.indices;
    return runSimplify(mesh.positions, mesh.indices, ratio, adaptiveError(ratio));
  });
}
