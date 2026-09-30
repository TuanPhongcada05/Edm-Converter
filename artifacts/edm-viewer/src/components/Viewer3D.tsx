import { Component, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import { api } from "@/lib/api";
import {
  Loader2,
  AlertCircle,
  Maximize2,
  Box,
  Grid3x3,
  Sun,
  Moon,
  Axis3d,
  RotateCcw,
} from "lucide-react";

interface Props {
  file: string;
}

type ViewName = "iso" | "top" | "front" | "right" | "back" | "left" | "bottom";

interface SceneRefs {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  gridHelper: THREE.GridHelper;
  axesHelper: THREE.AxesHelper;
  modelGroup: THREE.Group;
  hemiLight: THREE.HemisphereLight;
  dirLight: THREE.DirectionalLight;
  ambientLight: THREE.AmbientLight;
  rafId: number | null;
  resizeObserver: ResizeObserver | null;
  bbox: THREE.Box3;
  bsphere: THREE.Sphere;
  wireOverlays: THREE.LineSegments[];
}

export function Viewer3D({ file }: Props) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<SceneRefs | null>(null);

  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<{ tris: number; verts: number; meshes: number } | null>(
    null,
  );

  // Toolbar state
  const [shading, setShading] = useState<"shaded" | "wire" | "shaded-wire">(
    "shaded",
  );
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [bgMode, setBgMode] = useState<"light" | "dark">("dark");

  // ---------------------------------------------------------------------------
  // Suppress GLTFLoader's noisy "Couldn't load texture" warnings for the
  // entire lifetime of the viewer — DCS .dds textures are intentionally not
  // bundled with the GLB export and we replace materials anyway. Texture
  // loads happen asynchronously after onLoad() resolves so we cannot scope
  // this to just the parse phase.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const original = console.error;
    console.error = (...args: unknown[]) => {
      if (
        typeof args[0] === "string" &&
        args[0].startsWith("THREE.GLTFLoader: Couldn't load texture")
      ) {
        return;
      }
      original.apply(console, args as Parameters<typeof console.error>);
    };
    return () => {
      console.error = original;
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Scene setup (runs once on mount)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const width = mount.clientWidth || 800;
    const height = mount.clientHeight || 600;

    // Guard against environments where WebGL is unavailable (sandboxed iframes,
    // headless servers, old mobile browsers, etc.). Without this try/catch the
    // constructor throws an unhandled Error that crashes the entire React tree.
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      setError(
        "Trình duyệt không hỗ trợ WebGL — không thể hiển thị mô hình 3D. " +
          "Các tính năng xuất file vẫn hoạt động bình thường.",
      );
      setLoading(false);
      return;
    }
    // Also handle the case where Three.js created a dummy renderer (no context).
    if (!renderer.getContext()) {
      renderer.dispose();
      setError(
        "Không tạo được WebGL context — trình duyệt có thể đang chặn GPU " +
          "hoặc thiếu driver đồ họa. Các tính năng xuất file vẫn dùng được.",
      );
      setLoading(false);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    mount.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1d24);

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 50_000);
    camera.position.set(80, 60, 80);
    camera.up.set(0, 1, 0);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.01;
    controls.maxDistance = 20_000;
    controls.zoomSpeed = 1.2;
    controls.rotateSpeed = 0.9;
    controls.panSpeed = 0.9;

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.35);
    scene.add(ambientLight);

    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x404040, 0.7);
    hemiLight.position.set(0, 200, 0);
    scene.add(hemiLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
    dirLight.position.set(120, 200, 80);
    scene.add(dirLight);

    const gridHelper = new THREE.GridHelper(100, 20, 0x4d5263, 0x2c303a);
    (gridHelper.material as THREE.Material).transparent = true;
    (gridHelper.material as THREE.Material).opacity = 0.6;
    scene.add(gridHelper);

    const axesHelper = new THREE.AxesHelper(20);
    scene.add(axesHelper);

    const modelGroup = new THREE.Group();
    scene.add(modelGroup);

    const bbox = new THREE.Box3();
    const bsphere = new THREE.Sphere();
    const wireOverlays: THREE.LineSegments[] = [];

    refs.current = {
      renderer,
      scene,
      camera,
      controls,
      gridHelper,
      axesHelper,
      modelGroup,
      hemiLight,
      dirLight,
      ambientLight,
      rafId: null,
      resizeObserver: null,
      bbox,
      bsphere,
      wireOverlays,
    };

    const animate = () => {
      if (!refs.current) return;
      refs.current.rafId = requestAnimationFrame(animate);
      refs.current.controls.update();
      refs.current.renderer.render(refs.current.scene, refs.current.camera);
    };
    animate();

    const ro = new ResizeObserver(() => {
      const r = refs.current;
      if (!r || !mountRef.current) return;
      const w = mountRef.current.clientWidth;
      const h = mountRef.current.clientHeight;
      if (w === 0 || h === 0) return;
      r.renderer.setSize(w, h, false);
      r.camera.aspect = w / h;
      r.camera.updateProjectionMatrix();
    });
    ro.observe(mount);
    refs.current.resizeObserver = ro;

    return () => {
      const r = refs.current;
      refs.current = null;
      if (!r) return;
      if (r.rafId !== null) cancelAnimationFrame(r.rafId);
      r.resizeObserver?.disconnect();
      r.controls.dispose();
      r.renderer.dispose();
      r.scene.traverse((o) => {
        if ((o as THREE.Mesh).geometry) {
          (o as THREE.Mesh).geometry.dispose();
        }
        const mat = (o as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
      if (r.renderer.domElement.parentElement === mount) {
        mount.removeChild(r.renderer.domElement);
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Load model whenever `file` changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!file) return;
    const r = refs.current;
    if (!r) return;

    let cancelled = false;
    setLoading(true);
    setProgress(null);
    setError(null);
    setStats(null);

    // Clear existing model
    while (r.modelGroup.children.length > 0) {
      const child = r.modelGroup.children.pop()!;
      child.traverse((o) => {
        if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose();
        const mat = (o as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
    }
    r.wireOverlays.length = 0;

    const url = api.exportUrl("glb", file);

    // Manual fetch so we can show progress + work around CORS-friendly URLs.
    (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

        const total = Number(res.headers.get("content-length") ?? 0);
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.length;
            if (total > 0) setProgress(received / total);
          }
        } else {
          chunks.push(new Uint8Array(await res.arrayBuffer()));
        }
        if (cancelled) return;

        const blob = new Blob(chunks as BlobPart[]);
        const arrayBuffer = await blob.arrayBuffer();
        if (cancelled) return;

        const loader = new GLTFLoader();
        loader.parse(
          arrayBuffer,
          "",
          (gltf) => {
            if (cancelled || !refs.current) return;
            const r2 = refs.current;
            const root = gltf.scene;

            let triCount = 0;
            let vertCount = 0;
            let meshCount = 0;
            root.traverse((obj) => {
              const mesh = obj as THREE.Mesh;
              if (mesh.isMesh && mesh.geometry) {
                meshCount++;
                const geom = mesh.geometry;
                const pos = geom.getAttribute("position");
                if (pos) vertCount += pos.count;
                const idx = geom.getIndex();
                if (idx) triCount += idx.count / 3;
                else if (pos) triCount += pos.count / 3;

                // Replace materials with one that pairs nicely with both light
                // and dark backgrounds. Keep textures/maps where present.
                const orig = mesh.material as THREE.Material | THREE.Material[];
                const wrap = (m: THREE.Material): THREE.Material => {
                  const std = new THREE.MeshStandardMaterial({
                    color: 0xc8ccd2,
                    metalness: 0.15,
                    roughness: 0.7,
                    side: THREE.DoubleSide,
                    flatShading: false,
                  });
                  if ((m as THREE.MeshStandardMaterial).map) {
                    std.map = (m as THREE.MeshStandardMaterial).map;
                    std.color.set(0xffffff);
                  }
                  return std;
                };
                if (Array.isArray(orig)) {
                  mesh.material = orig.map(wrap);
                } else {
                  mesh.material = wrap(orig);
                }
              }
            });

            r2.modelGroup.add(root);

            // Compute bounds
            r2.bbox.setFromObject(r2.modelGroup);
            r2.bbox.getBoundingSphere(r2.bsphere);

            // Auto-fit camera & adjust grid
            fitCameraToBounds(r2, "iso");
            adjustGridToBounds(r2);

            // Apply current shading mode (rebuilds wireframe overlays)
            applyShadingMode(r2, shading);

            setStats({
              tris: Math.round(triCount),
              verts: vertCount,
              meshes: meshCount,
            });
            setLoading(false);
            setProgress(null);
          },
          (err) => {
            if (cancelled) return;
            console.error("GLTF parse error", err);
            const msg =
              (err as { message?: string })?.message ?? String(err);
            setError(`Không đọc được .glb: ${msg}`);
            setLoading(false);
          },
        );
      } catch (err) {
        if (cancelled) return;
        setError(`Không tải được model: ${(err as Error).message ?? err}`);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Apply shading mode whenever it changes.
  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    applyShadingMode(r, shading);
  }, [shading]);

  // Toggle grid / axes
  useEffect(() => {
    if (refs.current) refs.current.gridHelper.visible = showGrid;
  }, [showGrid]);
  useEffect(() => {
    if (refs.current) refs.current.axesHelper.visible = showAxes;
  }, [showAxes]);

  // Background
  useEffect(() => {
    const r = refs.current;
    if (!r) return;
    if (bgMode === "dark") {
      r.scene.background = new THREE.Color(0x1a1d24);
      r.ambientLight.intensity = 0.35;
    } else {
      r.scene.background = new THREE.Color(0xeef0f3);
      r.ambientLight.intensity = 0.6;
    }
  }, [bgMode]);

  function setView(view: ViewName) {
    const r = refs.current;
    if (!r) return;
    fitCameraToBounds(r, view);
  }

  function resetView() {
    const r = refs.current;
    if (!r) return;
    fitCameraToBounds(r, "iso");
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-muted/30 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap">
            <ViewBtn label="ISO" onClick={() => setView("iso")} />
            <ViewBtn label="Trước" onClick={() => setView("front")} />
            <ViewBtn label="Sau" onClick={() => setView("back")} />
            <ViewBtn label="Trái" onClick={() => setView("left")} />
            <ViewBtn label="Phải" onClick={() => setView("right")} />
            <ViewBtn label="Trên" onClick={() => setView("top")} />
            <ViewBtn label="Dưới" onClick={() => setView("bottom")} />
            <div className="w-px h-5 bg-border mx-1" />
            <Button
              variant="ghost"
              size="sm"
              onClick={resetView}
              className="h-7 px-2"
              data-testid="button-fit-view"
              title="Vừa khung hình"
            >
              <Maximize2 className="h-3.5 w-3.5 mr-1" /> Fit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetView}
              className="h-7 px-2"
              data-testid="button-reset-view"
              title="Reset góc nhìn"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-1.5">
            <Toggle
              size="sm"
              pressed={shading === "shaded"}
              onPressedChange={(p) => p && setShading("shaded")}
              className="h-7 px-2 text-xs"
              data-testid="toggle-shaded"
              aria-label="Shaded"
            >
              <Box className="h-3.5 w-3.5 mr-1" /> Shaded
            </Toggle>
            <Toggle
              size="sm"
              pressed={shading === "shaded-wire"}
              onPressedChange={(p) => p && setShading("shaded-wire")}
              className="h-7 px-2 text-xs"
              data-testid="toggle-shaded-wire"
              aria-label="Shaded + Wire"
            >
              + Wire
            </Toggle>
            <Toggle
              size="sm"
              pressed={shading === "wire"}
              onPressedChange={(p) => p && setShading("wire")}
              className="h-7 px-2 text-xs"
              data-testid="toggle-wire"
              aria-label="Wireframe"
            >
              Wire
            </Toggle>
            <div className="w-px h-5 bg-border mx-1" />
            <Toggle
              size="sm"
              pressed={showGrid}
              onPressedChange={setShowGrid}
              className="h-7 px-2 text-xs"
              data-testid="toggle-grid"
              title="Hiện/ẩn lưới"
            >
              <Grid3x3 className="h-3.5 w-3.5" />
            </Toggle>
            <Toggle
              size="sm"
              pressed={showAxes}
              onPressedChange={setShowAxes}
              className="h-7 px-2 text-xs"
              data-testid="toggle-axes"
              title="Hiện/ẩn trục"
            >
              <Axis3d className="h-3.5 w-3.5" />
            </Toggle>
            <Toggle
              size="sm"
              pressed={bgMode === "light"}
              onPressedChange={(p) => setBgMode(p ? "light" : "dark")}
              className="h-7 px-2 text-xs"
              data-testid="toggle-bg"
              title="Đổi nền sáng/tối"
            >
              {bgMode === "light" ? (
                <Sun className="h-3.5 w-3.5" />
              ) : (
                <Moon className="h-3.5 w-3.5" />
              )}
            </Toggle>
          </div>
        </div>

        <div
          ref={mountRef}
          className="relative w-full"
          style={{ height: "min(70vh, 720px)", minHeight: "420px" }}
          data-testid="viewer-canvas"
        >
          {loading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-background/70 backdrop-blur-sm z-10 pointer-events-none">
              <Loader2 className="h-6 w-6 animate-spin text-primary mb-3" />
              <div className="text-sm font-medium">Đang dựng mô hình 3D…</div>
              <div className="text-xs text-muted-foreground mt-1">
                {progress !== null
                  ? `${Math.round(progress * 100)}% (đang tải .glb)`
                  : "Đang chuẩn bị scene"}
              </div>
              {progress !== null && (
                <div className="mt-3 w-56 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
              )}
            </div>
          )}
          {error && !loading && (
            <div className="absolute inset-0 flex items-center justify-center bg-background/80 z-10 p-6">
              <div className="max-w-md text-center">
                <AlertCircle className="h-6 w-6 text-destructive mx-auto mb-2" />
                <div className="text-sm font-semibold text-destructive">
                  Không hiển thị được mô hình
                </div>
                <div className="text-xs text-muted-foreground mt-2 font-mono break-all">
                  {error}
                </div>
              </div>
            </div>
          )}

          {/* Stats overlay */}
          {stats && !loading && (
            <div className="absolute bottom-3 left-3 flex gap-1.5 z-10 pointer-events-none">
              <Badge variant="secondary" className="font-mono text-[10px]">
                {stats.meshes} meshes
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {stats.verts.toLocaleString()} verts
              </Badge>
              <Badge variant="secondary" className="font-mono text-[10px]">
                {stats.tris.toLocaleString()} tris
              </Badge>
            </div>
          )}

          {/* Hint overlay */}
          {!loading && !error && (
            <div className="absolute bottom-3 right-3 z-10 pointer-events-none">
              <div className="bg-background/70 backdrop-blur-sm rounded-md px-2.5 py-1.5 text-[10px] text-muted-foreground font-mono leading-relaxed border">
                <div>Trái: xoay · Phải: pan · Cuộn: zoom</div>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ViewBtn({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs"
      onClick={onClick}
      data-testid={`view-${label.toLowerCase()}`}
    >
      {label}
    </Button>
  );
}

function fitCameraToBounds(r: SceneRefs, view: ViewName) {
  if (r.bsphere.radius <= 0 || !Number.isFinite(r.bsphere.radius)) {
    // No model loaded yet — pick a reasonable default
    r.camera.position.set(80, 60, 80);
    r.controls.target.set(0, 0, 0);
    r.controls.update();
    return;
  }
  const center = r.bsphere.center.clone();
  const radius = r.bsphere.radius;
  const fov = (r.camera.fov * Math.PI) / 180;
  const dist = (radius / Math.sin(fov / 2)) * 1.15;

  const dirs: Record<ViewName, THREE.Vector3> = {
    iso: new THREE.Vector3(1, 0.8, 1).normalize(),
    front: new THREE.Vector3(0, 0, 1),
    back: new THREE.Vector3(0, 0, -1),
    right: new THREE.Vector3(1, 0, 0),
    left: new THREE.Vector3(-1, 0, 0),
    top: new THREE.Vector3(0, 1, 0.001).normalize(),
    bottom: new THREE.Vector3(0, -1, 0.001).normalize(),
  };
  const dir = dirs[view];

  r.camera.position.copy(center).addScaledVector(dir, dist);
  r.camera.up.set(0, 1, 0);
  r.camera.lookAt(center);
  r.camera.near = Math.max(0.01, dist / 1000);
  r.camera.far = Math.max(2_000, dist * 50);
  r.camera.updateProjectionMatrix();

  r.controls.target.copy(center);
  r.controls.minDistance = Math.max(0.01, radius / 100);
  r.controls.maxDistance = dist * 50;
  r.controls.update();
}

function adjustGridToBounds(r: SceneRefs) {
  // Scale grid to model footprint
  const size = r.bsphere.radius * 4;
  const niceSize = niceRound(size);
  const divisions = 20;
  // Replace grid helper
  r.scene.remove(r.gridHelper);
  (r.gridHelper.geometry as THREE.BufferGeometry).dispose();
  (r.gridHelper.material as THREE.Material).dispose();
  const newGrid = new THREE.GridHelper(
    niceSize,
    divisions,
    0x4d5263,
    0x2c303a,
  );
  (newGrid.material as THREE.Material).transparent = true;
  (newGrid.material as THREE.Material).opacity = 0.55;
  newGrid.position.y = r.bbox.min.y; // Sit grid at floor of model
  newGrid.visible = r.gridHelper.visible;
  r.gridHelper = newGrid;
  r.scene.add(newGrid);

  // Resize axes too
  r.scene.remove(r.axesHelper);
  (r.axesHelper.geometry as THREE.BufferGeometry).dispose();
  (r.axesHelper.material as THREE.Material).dispose();
  const newAxes = new THREE.AxesHelper(niceSize / 4);
  newAxes.visible = r.axesHelper.visible;
  r.axesHelper = newAxes;
  r.scene.add(newAxes);
}

function niceRound(n: number): number {
  if (n <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(n)));
  const m = n / exp;
  let nice = 1;
  if (m < 1.5) nice = 1;
  else if (m < 3) nice = 2;
  else if (m < 7) nice = 5;
  else nice = 10;
  return nice * exp;
}

function applyShadingMode(
  r: SceneRefs,
  mode: "shaded" | "wire" | "shaded-wire",
) {
  // Tear down any existing wire overlays
  for (const overlay of r.wireOverlays) {
    overlay.parent?.remove(overlay);
    overlay.geometry.dispose();
    (overlay.material as THREE.Material).dispose();
  }
  r.wireOverlays.length = 0;

  r.modelGroup.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (
        m instanceof THREE.MeshStandardMaterial ||
        m instanceof THREE.MeshBasicMaterial
      ) {
        m.wireframe = mode === "wire";
        m.needsUpdate = true;
      }
    }
    mesh.visible = true;

    if (mode === "shaded-wire") {
      const wireGeom = new THREE.WireframeGeometry(mesh.geometry);
      const wireMat = new THREE.LineBasicMaterial({
        color: 0x1a1f29,
        transparent: true,
        opacity: 0.35,
        depthTest: true,
      });
      const wire = new THREE.LineSegments(wireGeom, wireMat);
      wire.position.copy(mesh.position);
      wire.rotation.copy(mesh.rotation);
      wire.scale.copy(mesh.scale);
      wire.matrix.copy(mesh.matrix);
      wire.matrixAutoUpdate = mesh.matrixAutoUpdate;
      mesh.add(wire);
      r.wireOverlays.push(wire);
    }
  });
}

// ---------------------------------------------------------------------------
// Error boundary — catches any uncaught render / lifecycle errors from
// Viewer3D and shows a graceful fallback instead of crashing the whole app.
// ---------------------------------------------------------------------------

interface EBProps {
  children: ReactNode;
}
interface EBState {
  caught: boolean;
  message: string;
}

export class Viewer3DErrorBoundary extends Component<EBProps, EBState> {
  constructor(props: EBProps) {
    super(props);
    this.state = { caught: false, message: "" };
  }

  static getDerivedStateFromError(err: unknown): EBState {
    return {
      caught: true,
      message:
        err instanceof Error ? err.message : "Lỗi không xác định trong trình xem 3D.",
    };
  }

  render() {
    if (this.state.caught) {
      return (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <AlertCircle className="h-8 w-8 text-destructive" />
            <div className="text-sm font-semibold text-destructive">
              Trình xem 3D gặp lỗi
            </div>
            <div className="text-xs text-muted-foreground font-mono max-w-md break-all">
              {this.state.message}
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Các tab Xuất, Header, Strings và Hex vẫn hoạt động bình thường.
            </div>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
