import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { api, formatBytes, formatHexOffset } from "@/lib/api";

export function HeaderPanel({ file }: { file: string }) {
  const q = useQuery({
    queryKey: ["edm", "header", file],
    queryFn: () => api.header(file),
  });

  if (q.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (q.error || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Failed to read header</CardTitle>
          <CardDescription className="font-mono text-xs">
            {String(q.error)}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const h = q.data;

  const rows: Array<[string, string, string?]> = [
    ["Magic", h.magic, "ASCII bytes 0–2"],
    ["Version", `${h.version}  (0x${h.version.toString(16)})`, "uint16 LE @ offset 3"],
    ["String count", `${h.stringCount.toLocaleString()}  (0x${h.stringCount.toString(16)})`, "uint32 LE @ offset 5"],
    ["String table starts", formatHexOffset(9), "right after the count"],
    ["String table ends", `${formatHexOffset(h.stringTableEnd)}  (${h.stringTableEnd.toLocaleString()} B)`, "first byte of the body section"],
    ["File size", `${formatBytes(h.fileSize)}  (${h.fileSize.toLocaleString()} B)`],
    ["Body size", `${formatBytes(h.fileSize - h.stringTableEnd)}  (${(h.fileSize - h.stringTableEnd).toLocaleString()} B)`, "everything after the string table"],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>File header</CardTitle>
        <CardDescription>
          EDM v{h.version} — magic <code className="font-mono">EDM</code>, followed by a uint16 version,
          a uint32 string-table count, then that many null-terminated UTF-8 strings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border divide-y">
          {rows.map(([label, value, hint]) => (
            <div key={label} className="grid grid-cols-12 px-4 py-2.5 text-sm">
              <div className="col-span-4 text-muted-foreground">{label}</div>
              <div className="col-span-5 font-mono">{value}</div>
              <div className="col-span-3 text-xs text-muted-foreground">
                {hint}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
