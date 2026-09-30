import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, formatBytes, formatHexOffset, type EdmFileInfo } from "@/lib/api";
import { HeaderPanel } from "@/components/HeaderPanel";
import { StringsPanel } from "@/components/StringsPanel";
import { HexPanel } from "@/components/HexPanel";
import { UsagePanel } from "@/components/UsagePanel";
import { ExportPanel } from "@/components/ExportPanel";
import { Viewer3D, Viewer3DErrorBoundary } from "@/components/Viewer3D";
import {
  FileText,
  Binary,
  Hash,
  BarChart3,
  Download,
  Upload,
  Trash2,
  Loader2,
  Box,
  Layers,
  ScanSearch,
  PackageOpen,
  Zap,
  ShieldCheck,
  Eye,
} from "lucide-react";

export default function Inspector() {
  const queryClient = useQueryClient();
  const filesQuery = useQuery({
    queryKey: ["edm", "files"],
    queryFn: () => api.files(),
  });
  const [selectedFile, setSelectedFile] = useState<string | undefined>(
    undefined,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState<{
    name: string;
    sent: number;
    total: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const files = filesQuery.data?.files ?? [];
  const activeFile =
    files.find((f) => f.fileName === selectedFile) ?? files[0];

  async function handleUpload(file: File) {
    setUploadError(null);
    setUploading({ name: file.name, sent: 0, total: file.size });
    try {
      const uploaded = await api.upload(file, (sent, total) => {
        setUploading({ name: file.name, sent, total });
      });
      await queryClient.invalidateQueries({ queryKey: ["edm", "files"] });
      setSelectedFile(uploaded.fileName);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleDelete(file: EdmFileInfo) {
    if (file.source !== "upload") return;
    if (!window.confirm(`Xoá file "${file.fileName}"?`)) return;
    try {
      await api.deleteFile(file.fileName);
      // Pick a different file if we were viewing this one.
      if (activeFile?.fileName === file.fileName) {
        setSelectedFile(undefined);
      }
      await queryClient.invalidateQueries({ queryKey: ["edm", "files"] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-sidebar">
        <div className="mx-auto max-w-7xl px-6 py-5 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
              <Binary className="h-5 w-5 text-primary" />
              EDM File Inspector
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Parse and explore DCS World <code className="font-mono">.edm</code> binary files.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge variant="secondary" className="font-mono">v10 supported</Badge>
            <input
              ref={fileInputRef}
              type="file"
              accept=".edm,.EDM"
              className="hidden"
              data-testid="input-upload"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={!!uploading}
              data-testid="button-upload"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5 mr-1.5" />
              )}
              {uploading ? "Đang tải lên…" : "Tải file EDM"}
            </Button>
            {files.length > 0 ? (
              <div className="flex items-center gap-1.5">
                <Select
                  value={activeFile?.fileName ?? ""}
                  onValueChange={(v) => setSelectedFile(v)}
                >
                  <SelectTrigger
                    className="w-[320px] font-mono text-xs"
                    data-testid="select-file"
                  >
                    <SelectValue placeholder="Chọn file…" />
                  </SelectTrigger>
                  <SelectContent>
                    {files.map((f) => (
                      <SelectItem
                        key={f.fileName}
                        value={f.fileName}
                        className="font-mono text-xs"
                      >
                        {f.source === "upload" ? "↑ " : ""}
                        {f.fileName} · {formatBytes(f.fileSize)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {activeFile?.source === "upload" ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => activeFile && handleDelete(activeFile)}
                    title="Xoá file đã tải lên"
                    data-testid="button-delete-file"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
        {uploading || uploadError ? (
          <div className="mx-auto max-w-7xl px-6 pb-3 -mt-2">
            {uploading ? (
              <div className="flex items-center gap-3 text-xs">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                <span className="font-mono truncate">{uploading.name}</span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{
                      width:
                        uploading.total > 0
                          ? `${Math.round((uploading.sent / uploading.total) * 100)}%`
                          : "0%",
                    }}
                  />
                </div>
                <span className="font-mono text-muted-foreground tabular-nums">
                  {formatBytes(uploading.sent)} / {formatBytes(uploading.total)}
                </span>
              </div>
            ) : null}
            {uploadError ? (
              <div
                className="text-xs text-destructive font-mono"
                data-testid="text-upload-error"
              >
                Lỗi tải lên: {uploadError}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      <main className="mx-auto max-w-7xl px-6 py-6">
        {filesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Đang quét thư mục file EDM…</p>
        ) : files.length === 0 ? (
          <WelcomeScreen onUploadClick={() => fileInputRef.current?.click()} />
        ) : !activeFile ? null : (
          <InspectorTabs file={activeFile.fileName} />
        )}
      </main>
    </div>
  );
}

function WelcomeScreen({ onUploadClick }: { onUploadClick: () => void }) {
  const features = [
    {
      icon: <Eye className="h-5 w-5 text-primary" />,
      title: "Xem trước 3D ngay trên trình duyệt",
      desc: "Quay/zoom/pan kiểu SketchUp. Có sẵn các view ISO, Trước/Sau/Trái/Phải/Trên/Dưới, chế độ shaded / wireframe / shaded + wire, lưới và trục toạ độ tự co theo kích thước model.",
    },
    {
      icon: <ScanSearch className="h-5 w-5 text-primary" />,
      title: "Phân tích cấu trúc nhị phân",
      desc: "Đọc toàn bộ header, string table, node hierarchy và render nodes của file .edm DCS World phiên bản v8 và v10.",
    },
    {
      icon: <Box className="h-5 w-5 text-primary" />,
      title: "Xuất mô hình 3D",
      desc: "Chuyển đổi sang Wavefront OBJ+MTL, glTF Binary (.glb) và Autodesk FBX 7.4. Tất cả các định dạng đều import được trong Blender, Maya, 3ds Max.",
    },
    {
      icon: <Layers className="h-5 w-5 text-primary" />,
      title: "Tách object theo render node",
      desc: "Xuất mỗi render node thành một file .obj riêng biệt, đóng gói trong một file ZIP — tiện lợi khi làm việc từng bộ phận.",
    },
    {
      icon: <PackageOpen className="h-5 w-5 text-primary" />,
      title: "Xem hex & chuỗi ký tự",
      desc: "Duyệt nội dung nhị phân thô theo offset, tìm kiếm string table và tra cứu tham chiếu chuỗi trong toàn bộ file.",
    },
    {
      icon: <Zap className="h-5 w-5 text-primary" />,
      title: "Hỗ trợ file lớn",
      desc: "Upload chia nhỏ (chunked) tự động cho phép tải lên file hàng trăm MB mà không gặp lỗi giới hạn kích thước.",
    },
    {
      icon: <ShieldCheck className="h-5 w-5 text-primary" />,
      title: "Kiểm tra tính hợp lệ",
      desc: "Xác minh magic bytes, đếm trailing bytes chưa parse và thống kê từng loại node — phát hiện file hỏng hoặc phiên bản không được hỗ trợ.",
    },
  ];

  const formats = [
    { ext: ".obj + .mtl", label: "Wavefront OBJ" },
    { ext: ".glb", label: "glTF Binary" },
    { ext: ".fbx", label: "Autodesk FBX" },
    { ext: ".zip", label: "OBJ tách node" },
  ];

  return (
    <div className="space-y-10 py-4">
      {/* Hero */}
      <div className="text-center space-y-4 max-w-2xl mx-auto">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl bg-primary/10 mb-2">
          <Binary className="h-8 w-8 text-primary" />
        </div>
        <h2 className="text-3xl font-bold tracking-tight">EDM File Inspector</h2>
        <p className="text-muted-foreground text-base leading-relaxed">
          Công cụ phân tích và xuất file <code className="font-mono bg-muted px-1 py-0.5 rounded text-sm">.edm</code> của{" "}
          <strong>DCS World</strong> — hỗ trợ đọc cấu trúc nhị phân, xem metadata và chuyển đổi sang các định dạng 3D phổ biến.
        </p>
        <Button size="lg" onClick={onUploadClick} className="gap-2 px-8">
          <Upload className="h-4 w-4" />
          Tải file EDM lên để bắt đầu
        </Button>
        <p className="text-xs text-muted-foreground">
          Hỗ trợ DCS World EDM v8 và v10 · File lên đến 512 MB
        </p>
      </div>

      {/* Feature grid */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Tính năng
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map((f) => (
            <Card key={f.title} className="border-border/60">
              <CardContent className="pt-5 pb-5">
                <div className="flex items-start gap-3">
                  <div className="shrink-0 mt-0.5">{f.icon}</div>
                  <div>
                    <div className="font-medium text-sm mb-1">{f.title}</div>
                    <div className="text-xs text-muted-foreground leading-relaxed">{f.desc}</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Export formats */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Định dạng xuất được hỗ trợ
        </h3>
        <div className="flex flex-wrap gap-3">
          {formats.map((f) => (
            <div
              key={f.ext}
              className="flex items-center gap-2 border rounded-lg px-4 py-2.5 bg-card"
            >
              <Download className="h-3.5 w-3.5 text-primary" />
              <span className="font-mono text-xs font-semibold">{f.ext}</span>
              <span className="text-xs text-muted-foreground">{f.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* How to use */}
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-widest text-muted-foreground mb-4">
          Cách sử dụng
        </h3>
        <ol className="space-y-3">
          {[
            { step: "1", text: 'Bấm nút "Tải file EDM lên" hoặc nút ở góc trên bên phải.' },
            { step: "2", text: "Chọn file .edm từ máy tính. File có thể có dung lượng lớn — hệ thống tự động chia nhỏ khi upload." },
            { step: "3", text: "Sau khi upload xong, chọn tab Export để tải mô hình 3D, hoặc xem Header / Strings / Hex / Usage để phân tích chi tiết." },
          ].map((item) => (
            <li key={item.step} className="flex items-start gap-3">
              <span className="shrink-0 h-6 w-6 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                {item.step}
              </span>
              <span className="text-sm text-muted-foreground pt-0.5">{item.text}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function InspectorTabs({ file }: { file: string }) {
  const headerQuery = useQuery({
    queryKey: ["edm", "header", file],
    queryFn: () => api.header(file),
  });

  return (
    <div className="space-y-4">
      <SummaryCards file={file} />
      <Tabs defaultValue="preview" className="space-y-4">
        <TabsList className="grid grid-cols-6 max-w-4xl">
          <TabsTrigger value="preview" data-testid="tab-preview">
            <Eye className="h-3.5 w-3.5 mr-1.5" /> Preview 3D
          </TabsTrigger>
          <TabsTrigger value="export" data-testid="tab-export">
            <Download className="h-3.5 w-3.5 mr-1.5" /> Export
          </TabsTrigger>
          <TabsTrigger value="header" data-testid="tab-header">
            <FileText className="h-3.5 w-3.5 mr-1.5" /> Header
          </TabsTrigger>
          <TabsTrigger value="strings" data-testid="tab-strings">
            <Hash className="h-3.5 w-3.5 mr-1.5" /> Strings
          </TabsTrigger>
          <TabsTrigger value="hex" data-testid="tab-hex">
            <Binary className="h-3.5 w-3.5 mr-1.5" /> Hex
          </TabsTrigger>
          <TabsTrigger value="usage" data-testid="tab-usage">
            <BarChart3 className="h-3.5 w-3.5 mr-1.5" /> Usage
          </TabsTrigger>
        </TabsList>

        <TabsContent value="preview">
          <Viewer3DErrorBoundary>
            <Viewer3D file={file} />
          </Viewer3DErrorBoundary>
        </TabsContent>
        <TabsContent value="export">
          <ExportPanel file={file} />
        </TabsContent>
        <TabsContent value="header">
          <HeaderPanel file={file} />
        </TabsContent>
        <TabsContent value="strings">
          <StringsPanel file={file} />
        </TabsContent>
        <TabsContent value="hex">
          <HexPanel
            file={file}
            initialOffset={headerQuery.data?.stringTableEnd ?? 0}
            fileSize={headerQuery.data?.fileSize ?? 0}
          />
        </TabsContent>
        <TabsContent value="usage">
          <UsagePanel file={file} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SummaryCards({ file }: { file: string }) {
  const headerQuery = useQuery({
    queryKey: ["edm", "header", file],
    queryFn: () => api.header(file),
  });
  const h = headerQuery.data;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard label="Magic" value={h?.magic ?? "—"} mono />
      <StatCard label="Version" value={h ? `v${h.version}` : "—"} />
      <StatCard label="String Table" value={h ? `${h.stringCount.toLocaleString()} entries` : "—"} />
      <StatCard
        label="File Size"
        value={h ? formatBytes(h.fileSize) : "—"}
        sub={h ? formatHexOffset(h.fileSize) : undefined}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  mono,
}: {
  label: string;
  value: string;
  sub?: string;
  mono?: boolean;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className={`text-xl font-semibold mt-1 ${mono ? "font-mono" : ""}`}>
          {value}
        </div>
        {sub ? (
          <div className="text-xs text-muted-foreground font-mono mt-0.5">{sub}</div>
        ) : null}
      </CardContent>
    </Card>
  );
}
