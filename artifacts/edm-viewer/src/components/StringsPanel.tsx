import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { Search } from "lucide-react";

export function StringsPanel({ file }: { file: string }) {
  const q = useQuery({
    queryKey: ["edm", "strings", file],
    queryFn: () => api.strings(file),
  });
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = q.data?.strings ?? [];
    const indexed = all.map((value, index) => ({ index, value }));
    if (!search.trim()) return indexed;
    const needle = search.toLowerCase();
    return indexed.filter(
      (r) =>
        r.value.toLowerCase().includes(needle) ||
        String(r.index).includes(needle),
    );
  }, [q.data, search]);

  if (q.isLoading) return <Skeleton className="h-96 w-full" />;
  if (q.error || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Failed to read string table</CardTitle>
          <CardDescription className="font-mono text-xs">{String(q.error)}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>String table</CardTitle>
            <CardDescription>
              Used as a lookup throughout the rest of the file — every property name,
              material name, texture path and node name lives here.
            </CardDescription>
          </div>
          <Badge variant="secondary" className="font-mono">
            {q.data.count.toLocaleString()} entries
          </Badge>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Filter by text or index…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 font-mono text-sm"
            data-testid="input-search-strings"
          />
        </div>
        <div className="text-xs text-muted-foreground">
          Showing <span className="font-mono">{rows.length.toLocaleString()}</span> of{" "}
          <span className="font-mono">{q.data.count.toLocaleString()}</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card border-b text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 w-24">Index</th>
                <th className="text-left px-3 py-2 w-24">Hex</th>
                <th className="text-left px-3 py-2">Value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.index} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{r.index}</td>
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">
                    0x{r.index.toString(16).padStart(4, "0")}
                  </td>
                  <td className="px-3 py-1.5 font-mono whitespace-pre-wrap break-all">
                    {r.value === ""
                      ? <span className="text-muted-foreground italic">(empty)</span>
                      : escapeForDisplay(r.value)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-6 text-center text-muted-foreground">
                    No matches.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function escapeForDisplay(s: string): string {
  // Show control chars visibly so they don't mangle layout.
  return s.replace(/[\x00-\x1f\x7f]/g, (ch) => {
    const code = ch.charCodeAt(0);
    if (ch === "\n") return "\\n";
    if (ch === "\r") return "\\r";
    if (ch === "\t") return "\\t";
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}
