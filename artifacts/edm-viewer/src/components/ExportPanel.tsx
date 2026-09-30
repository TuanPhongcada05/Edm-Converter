import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api, formatBytes } from "@/lib/api";
import { Download, FileBox, Box, Layers, FolderOpen, AlertCircle, Loader2, Puzzle } from "lucide-react";

interface Props {
  file: string;
}

type Fmt = "obj" | "glb" | "fbx" | "zip-split" | "glb-islands" | "obj-islands";

export function ExportPanel({ file }: Props) {
  const bodyQuery = useQuery({
    queryKey: ["edm", "body", file],
    queryFn: () => api.body(file),
    retry: false,
  });

  const [downloading, setDownloading] = useState<Fmt | null>(null);
  // Global triangle budget (undefined = nguyên bản, không decimate).
  // Server phân bổ budget này cho từng mesh theo tỉ lệ; mesh nhỏ (≤300 tris)
  // được giữ nguyên để tránh mất chi tiết nhỏ.
  const [maxTris, setMaxTris] = useState<number | undefined>(undefined);
  // Minimum triangles per island for the island-split export. Higher = fewer objects.
  const [minIslandTris, setMinIslandTris] = useState<number>(100);

  async function downloadFile(format: Fmt, fileName: string) {
    setDownloading(format);
    try {
      const isIsland = format === "glb-islands" || format === "obj-islands";
      const url = api.exportUrl(
        format,
        file,
        maxTris,
        isIsland ? { minTris: String(minIslandTris) } : undefined,
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (format === "obj") {
        // .mtl không phụ thuộc vào số lượng tam giác — luôn dùng bản gốc.
        const mtlUrl = api.exportUrl("mtl", file);
        const a2 = document.createElement("a");
        a2.href = mtlUrl;
        a2.download = fileName.replace(/\.obj$/i, ".mtl");
        document.body.appendChild(a2);
        a2.click();
        document.body.removeChild(a2);
      }
    } finally {
      setTimeout(() => setDownloading(null), 1500);
    }
  }

  if (bodyQuery.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Đang phân tích file EDM…
          </CardTitle>
          <CardDescription>
            Lần đầu có thể mất vài giây để đọc 92&nbsp;MB binary.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  if (bodyQuery.error) {
    return (
      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertCircle className="h-4 w-4" />
            Không thể phân tích phần body
          </CardTitle>
          <CardDescription className="font-mono text-xs">
            {String(bodyQuery.error)}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const body = bodyQuery.data!;
  const baseName = file.replace(/\.edm$/i, "");
  const verts = body.totals.vertices;
  const tris = body.totals.triangles;
  const cleanParse = body.trailingBytes === 0;

  return (
    <div className="space-y-4">
      {/* Stats banner */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <CardTitle className="text-lg">Sẵn sàng xuất</CardTitle>
              <CardDescription>
                {body.renderNodes.length} render node · {verts.toLocaleString()} đỉnh ·{" "}
                {tris.toLocaleString()} tam giác · {body.root.materials.length} vật liệu
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Badge variant={cleanParse ? "default" : "destructive"} className="font-mono">
                {cleanParse ? "Parse OK" : `${body.trailingBytes} byte dư`}
              </Badge>
              <Badge variant="secondary" className="font-mono">v{body.version}</Badge>
            </div>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <DecimationSelector
            maxTris={maxTris}
            originalTris={tris}
            disabled={downloading !== null}
            onChange={setMaxTris}
          />
        </CardContent>
      </Card>

      {/* Download cards */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-3">
        <ExportCard
          icon={<FileBox className="h-5 w-5" />}
          title="Wavefront OBJ"
          subtitle=".obj + .mtl"
          description={`Định dạng văn bản, mở được bằng mọi phần mềm 3D. Chứa ${body.renderNodes.length} object riêng biệt (mỗi render node = 1 object) — Blender sẽ hiển thị từng bộ phận tách rời. Texture tham chiếu tên file .dds gốc.`}
          buttonLabel="Tải .obj + .mtl"
          buttonIcon={<Download className="h-4 w-4" />}
          loading={downloading === "obj"}
          onClick={() => downloadFile("obj", `${baseName}.obj`)}
          dataTestId="button-export-obj"
        />
        <ExportCard
          icon={<Box className="h-5 w-5" />}
          title="glTF Binary"
          subtitle=".glb"
          description={`Định dạng nhị phân chuẩn web/AR, gọn hơn OBJ ~5 lần. Chứa ${body.renderNodes.length} mesh node riêng biệt — mỗi render node là 1 đối tượng độc lập trong Blender 4.x, Three.js, Unreal.`}
          buttonLabel="Tải .glb"
          buttonIcon={<Download className="h-4 w-4" />}
          loading={downloading === "glb"}
          onClick={() => downloadFile("glb", `${baseName}.glb`)}
          dataTestId="button-export-glb"
        />
        <ExportCard
          icon={<Layers className="h-5 w-5" />}
          title="Autodesk FBX"
          subtitle=".fbx (Binary 7.4)"
          description={`Định dạng FBX Binary 7.4. Chứa ${body.renderNodes.length} Model node riêng biệt (Geometry + Model cho mỗi render node) — Blender, 3ds Max, Maya, Unreal đều thấy từng bộ phận tách rời. Transform đã bake vào vertex.`}
          buttonLabel="Tải .fbx"
          buttonIcon={<Download className="h-4 w-4" />}
          loading={downloading === "fbx"}
          onClick={() => downloadFile("fbx", `${baseName}.fbx`)}
          dataTestId="button-export-fbx"
        />
        <ExportCard
          icon={<FolderOpen className="h-5 w-5" />}
          title="Tách File (ZIP)"
          subtitle={`.zip — ${body.renderNodes.length} file .obj`}
          description={`Tách ${body.renderNodes.length} render node thành ${body.renderNodes.length} file .obj hoàn toàn riêng biệt, đóng gói trong ZIP cùng file .mtl dùng chung. Dùng khi muốn mỗi bộ phận là 1 file độc lập.`}
          buttonLabel="Tải .zip (split)"
          buttonIcon={<Download className="h-4 w-4" />}
          loading={downloading === "zip-split"}
          onClick={() => downloadFile("zip-split", `${baseName}_split.zip`)}
          dataTestId="button-export-zip-split"
        />
      </div>

      {/* Island-split exports */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Puzzle className="h-4 w-4 text-primary" />
            Tách theo bộ phận (Island Split)
          </CardTitle>
          <CardDescription>
            Tách theo topology vật lý: mỗi phần không kết nối nhau thành 1 object riêng trong Blender. Tự động <strong>hàn đỉnh biên</strong> (weld seam vertices) và <strong>loại bỏ mặt trùng lặp</strong> từ nhiều render node chồng lên nhau — giảm kích thước file ~40–50% và loại bỏ hoàn toàn hiện tượng Z-fighting.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          {/* Granularity selector */}
          <div className="flex items-center justify-between flex-wrap gap-3 border rounded-md p-3 bg-background">
            <div className="space-y-0.5">
              <div className="text-sm font-medium">Độ chi tiết tách</div>
              <div className="text-xs text-muted-foreground">
                Mức Thô: ít object, dễ quản lý · Mức Mịn: nhiều object nhỏ hơn
              </div>
            </div>
            <div className="inline-flex rounded-md border bg-muted/40 p-0.5" role="radiogroup">
              {([
                { value: 1000, label: "Thô" },
                { value: 500, label: "TB" },
                { value: 100, label: "Vừa" },
                { value: 10, label: "Mịn" },
              ] as const).map((p) => {
                const active = minIslandTris === p.value;
                return (
                  <button
                    key={p.label}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={downloading !== null}
                    onClick={() => setMinIslandTris(p.value)}
                    className={
                      "px-3 py-1 text-xs font-mono rounded-sm transition-colors " +
                      (active
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted disabled:opacity-50")
                    }
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <ExportCard
              icon={<Box className="h-5 w-5" />}
              title="GLB — Island Split"
              subtitle=".glb (1 file, nhiều object)"
              description="Tách tất cả render node theo đảo topology. Mở trong Blender: mỗi bộ phận rời là 1 object riêng biệt. Định dạng nhị phân, gọn nhất."
              buttonLabel="Tải .glb (islands)"
              buttonIcon={<Download className="h-4 w-4" />}
              loading={downloading === "glb-islands"}
              onClick={() => downloadFile("glb-islands", `${baseName}_islands.glb`)}
              dataTestId="button-export-glb-islands"
            />
            <ExportCard
              icon={<FileBox className="h-5 w-5" />}
              title="OBJ — Island Split"
              subtitle=".obj + .mtl (trong .zip)"
              description="Tách theo đảo topology, xuất sang OBJ văn bản. Đóng gói cùng .mtl trong một file ZIP. Tương thích với mọi phần mềm 3D."
              buttonLabel="Tải .zip (islands obj)"
              buttonIcon={<Download className="h-4 w-4" />}
              loading={downloading === "obj-islands"}
              onClick={() => downloadFile("obj-islands", `${baseName}_islands.zip`)}
              dataTestId="button-export-obj-islands"
            />
          </div>
        </CardContent>
      </Card>

      {/* Material / mesh tables */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Render nodes — {body.renderNodes.length} mesh riêng biệt</CardTitle>
          <CardDescription>
            Mỗi render node được xuất thành <strong>1 mesh/object riêng biệt</strong> trong tất cả định dạng (OBJ, GLB, FBX). Khi mở trong Blender, bạn sẽ thấy {body.renderNodes.length} đối tượng tách rời, không phải 1 cục.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded border overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 w-10">#</th>
                  <th className="px-3 py-2">Tên</th>
                  <th className="px-3 py-2">Vật liệu</th>
                  <th className="px-3 py-2 text-right">Đỉnh</th>
                  <th className="px-3 py-2 text-right">Tam giác</th>
                  <th className="px-3 py-2 text-right">Stride</th>
                </tr>
              </thead>
              <tbody>
                {body.renderNodes.map((rn) => {
                  const mat = body.root.materials[rn.material];
                  return (
                    <tr key={rn.index} className="border-t hover-elevate">
                      <td className="px-3 py-1.5 text-muted-foreground">{rn.index}</td>
                      <td className="px-3 py-1.5">{rn.name}</td>
                      <td className="px-3 py-1.5 text-muted-foreground">
                        [{rn.material}] {mat?.name ?? mat?.materialName ?? "—"}
                      </td>
                      <td className="px-3 py-1.5 text-right">{rn.vertexCount.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right">{rn.triangleCount.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right text-muted-foreground">{rn.vertexStride}f</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Vật liệu</CardTitle>
          <CardDescription>
            Mỗi vật liệu sẽ được ghi vào .mtl (OBJ) hoặc materials[] (glTF).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded border overflow-hidden">
            <table className="w-full text-xs font-mono">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 w-10">#</th>
                  <th className="px-3 py-2">Tên hiển thị</th>
                  <th className="px-3 py-2">Material name</th>
                  <th className="px-3 py-2">Texture</th>
                  <th className="px-3 py-2 text-right">Vertex fmt</th>
                </tr>
              </thead>
              <tbody>
                {body.root.materials.map((m) => (
                  <tr key={m.index} className="border-t hover-elevate">
                    <td className="px-3 py-1.5 text-muted-foreground">{m.index}</td>
                    <td className="px-3 py-1.5">{m.name ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted-foreground">{m.materialName ?? "—"}</td>
                    <td className="px-3 py-1.5">
                      {m.textures.length === 0
                        ? "—"
                        : m.textures.map((t) => t.name).join(", ")}
                    </td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">
                      {m.vertexFormat
                        ? `pos${m.vertexFormat.position} nrm${m.vertexFormat.normal} uv${m.vertexFormat.texture}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Lưu ý: Các file texture <code>.dds</code> trong DCS được tham chiếu theo
        tên (không nhúng vào file xuất). Bạn cần copy thư mục textures gốc đặt
        cạnh file <code>.obj</code> hoặc <code>.glb</code> để hiển thị đúng.
        Tổng kích thước hình học gốc:{" "}
        {formatBytes(verts * body.renderNodes[0]?.vertexStride * 4 || 0)} (vertex)
        + {formatBytes(tris * 3 * 4)} (index).
      </p>
    </div>
  );
}

/**
 * Triangle budget selector using absolute triangle count presets.
 *
 * The budget is sent to the server as `?maxTris=N` and the server distributes
 * it proportionally across all meshes. Small meshes (≤ 300 tris) are always
 * kept intact so tiny detail pieces never disappear.
 *
 * `undefined` = no decimation (original quality).
 */
function DecimationSelector({
  maxTris,
  originalTris,
  disabled,
  onChange,
}: {
  maxTris: number | undefined;
  originalTris: number;
  disabled?: boolean;
  onChange: (next: number | undefined) => void;
}) {
  const presets: Array<{ value: number | undefined; label: string; testId: string }> = [
    { value: undefined, label: "Nguyên bản", testId: "original" },
    { value: 500_000,   label: "500k",       testId: "500k"     },
    { value: 300_000,   label: "300k",       testId: "300k"     },
    { value: 200_000,   label: "200k",       testId: "200k"     },
    { value: 100_000,   label: "100k",       testId: "100k"     },
  ];

  const active = (p: number | undefined) =>
    p === undefined ? maxTris === undefined : maxTris === p;

  return (
    <div className="flex items-center justify-between flex-wrap gap-3 border-t pt-3">
      <div className="space-y-0.5">
        <div className="text-sm font-medium">Giảm tam giác</div>
        <div className="text-xs text-muted-foreground">
          {maxTris === undefined ? (
            <>Giữ nguyên {originalTris.toLocaleString()} tam giác — không decimate.</>
          ) : (
            <>
              Mục tiêu ~{maxTris.toLocaleString()} / {originalTris.toLocaleString()} tam giác.
              Mesh nhỏ (&le;300 tris) luôn được giữ nguyên. Silhouette tổng thể được bảo toàn.
            </>
          )}
        </div>
      </div>
      <div className="inline-flex rounded-md border bg-background p-0.5" role="radiogroup">
        {presets.map((p) => (
          <button
            key={p.testId}
            type="button"
            role="radio"
            aria-checked={active(p.value)}
            disabled={disabled || (p.value !== undefined && p.value >= originalTris)}
            onClick={() => onChange(p.value)}
            className={
              "px-3 py-1 text-xs font-mono rounded-sm transition-colors " +
              (active(p.value)
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed")
            }
            data-testid={`button-budget-${p.testId}`}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ExportCard({
  icon,
  title,
  subtitle,
  description,
  buttonLabel,
  buttonIcon,
  loading,
  disabled,
  onClick,
  dataTestId,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  description: string;
  buttonLabel: string;
  buttonIcon: React.ReactNode;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  dataTestId: string;
}) {
  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 text-primary">
          {icon}
          <CardTitle className="text-base">{title}</CardTitle>
        </div>
        <CardDescription className="font-mono text-xs">{subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col justify-between gap-3">
        <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
        <Button
          onClick={onClick}
          disabled={disabled || loading}
          className="w-full"
          data-testid={dataTestId}
        >
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Đang tạo file…
            </>
          ) : (
            <>
              {buttonIcon}
              <span className={buttonIcon ? "ml-2" : ""}>{buttonLabel}</span>
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
