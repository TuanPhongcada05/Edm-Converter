import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { api, formatBytes, formatHexOffset } from "@/lib/api";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";

const PAGE_SIZE = 512;
const ROW_BYTES = 16;

export function HexPanel({
  file,
  initialOffset,
  fileSize,
}: {
  file: string;
  initialOffset: number;
  fileSize: number;
}) {
  const [offset, setOffset] = useState(initialOffset);
  const [draftOffset, setDraftOffset] = useState(String(initialOffset));

  // Sync when the parent finally has the header info.
  useEffect(() => {
    if (initialOffset && offset === 0) {
      setOffset(initialOffset);
      setDraftOffset(String(initialOffset));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialOffset]);

  const q = useQuery({
    queryKey: ["edm", "hex", file, offset],
    queryFn: () => api.hex(offset, PAGE_SIZE, file),
    enabled: fileSize > 0,
  });

  const max = Math.max(0, fileSize - PAGE_SIZE);
  const goTo = (n: number) => {
    const clamped = Math.max(0, Math.min(max, Math.floor(n)));
    setOffset(clamped);
    setDraftOffset(String(clamped));
  };

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Hex viewer</CardTitle>
            <CardDescription>
              Random-access view into the raw bytes of the file.
            </CardDescription>
          </div>
          <Badge variant="secondary" className="font-mono">
            {formatBytes(fileSize)}
          </Badge>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor="offset-input" className="text-xs uppercase tracking-wider text-muted-foreground">
              Offset
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="offset-input"
                value={draftOffset}
                onChange={(e) => setDraftOffset(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = parseOffset(draftOffset);
                    if (v != null) goTo(v);
                  }
                }}
                className="font-mono w-44"
                placeholder="0 or 0x1abc"
                data-testid="input-offset"
              />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const v = parseOffset(draftOffset);
                  if (v != null) goTo(v);
                }}
                data-testid="button-go"
              >
                Go
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Jump</Label>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => goTo(0)} data-testid="button-start">
                Start
              </Button>
              <Button size="sm" variant="outline" onClick={() => goTo(initialOffset)} data-testid="button-body">
                After strings
              </Button>
              <Button size="sm" variant="outline" onClick={() => goTo(max)} data-testid="button-end">
                End
              </Button>
            </div>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Page</Label>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => goTo(offset - PAGE_SIZE)}
                disabled={offset === 0}
                data-testid="button-prev"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => goTo(offset + PAGE_SIZE)}
                disabled={offset >= max}
                data-testid="button-next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => q.refetch()} data-testid="button-refresh">
                <RotateCw className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {q.isLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : q.error || !q.data ? (
          <div className="text-sm text-destructive font-mono">{String(q.error)}</div>
        ) : (
          <HexDump chunk={q.data} />
        )}
      </CardContent>
    </Card>
  );
}

function parseOffset(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const v = t.startsWith("0x") || t.startsWith("0X") ? parseInt(t, 16) : Number(t);
  return Number.isFinite(v) && v >= 0 ? v : null;
}

function HexDump({ chunk }: { chunk: ReturnType<typeof Object> & { offset: number; hex: string; ascii: string; length: number } }) {
  const rows: { addr: number; bytes: string[]; ascii: string }[] = [];
  for (let i = 0; i < chunk.length; i += ROW_BYTES) {
    const bytes: string[] = [];
    for (let j = 0; j < ROW_BYTES && i + j < chunk.length; j++) {
      bytes.push(chunk.hex.slice((i + j) * 2, (i + j) * 2 + 2));
    }
    rows.push({
      addr: chunk.offset + i,
      bytes,
      ascii: chunk.ascii.slice(i, i + ROW_BYTES),
    });
  }
  return (
    <div className="rounded-md border bg-muted/20 overflow-auto">
      <table className="font-mono text-xs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.addr} className="hover:bg-muted/40">
              <td className="px-3 py-0.5 text-muted-foreground select-none border-r">
                {formatHexOffset(r.addr)}
              </td>
              <td className="px-3 py-0.5">
                <span className="inline-flex gap-1">
                  {r.bytes.map((b, i) => (
                    <span key={i} className={i === 8 ? "ml-2" : ""}>{b}</span>
                  ))}
                  {r.bytes.length < ROW_BYTES
                    ? Array.from({ length: ROW_BYTES - r.bytes.length }).map((_, i) => (
                        <span key={`pad-${i}`} className="opacity-0">··</span>
                      ))
                    : null}
                </span>
              </td>
              <td className="px-3 py-0.5 border-l text-foreground/80 whitespace-pre">
                {r.ascii}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
