import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { Search } from "lucide-react";

export function UsagePanel({ file }: { file: string }) {
  const q = useQuery({
    queryKey: ["edm", "usage", file],
    queryFn: () => api.usage(file),
  });
  const [search, setSearch] = useState("");

  const rows = useMemo(() => {
    const all = q.data?.usage ?? [];
    const sorted = [...all].sort((a, b) => b.references - a.references);
    if (!search.trim()) return sorted;
    const needle = search.toLowerCase();
    return sorted.filter(
      (r) =>
        r.value.toLowerCase().includes(needle) ||
        String(r.index).includes(needle),
    );
  }, [q.data, search]);

  if (q.isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Scanning the file…</CardTitle>
          <CardDescription>
            Counting plausible 32-bit references to each string. This walks up to 16 MB after the string table.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-96 w-full" />
        </CardContent>
      </Card>
    );
  }
  if (q.error || !q.data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-destructive">Failed to scan</CardTitle>
          <CardDescription className="font-mono text-xs">{String(q.error)}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const total = rows.reduce((s, r) => s + r.references, 0);
  const max = rows[0]?.references ?? 0;

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>String reference frequency</CardTitle>
            <CardDescription>
              Heuristic: every aligned 32-bit little-endian value in the body is treated as a possible
              string-table index. The most-referenced strings are typically the property names that
              structure the rest of the file.
            </CardDescription>
          </div>
          <Badge variant="secondary" className="font-mono">
            {total.toLocaleString()} hits
          </Badge>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 font-mono text-sm"
            data-testid="input-search-usage"
          />
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-md border max-h-[60vh] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card border-b text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 w-20">Index</th>
                <th className="text-left px-3 py-2">String</th>
                <th className="text-right px-3 py-2 w-24">Refs</th>
                <th className="text-left px-3 py-2 w-48">Frequency</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 500).map((r) => (
                <tr key={r.index} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-1.5 font-mono text-muted-foreground">{r.index}</td>
                  <td className="px-3 py-1.5 font-mono whitespace-pre-wrap break-all">
                    {r.value === "" ? (
                      <span className="text-muted-foreground italic">(empty)</span>
                    ) : (
                      r.value
                    )}
                  </td>
                  <td className="px-3 py-1.5 font-mono text-right">{r.references.toLocaleString()}</td>
                  <td className="px-3 py-1.5">
                    <div className="h-2 rounded bg-muted overflow-hidden">
                      <div
                        className="h-full bg-primary"
                        style={{
                          width: max > 0 ? `${(r.references / max) * 100}%` : "0%",
                        }}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 500 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t">
              Showing top 500 of {rows.length.toLocaleString()} entries. Use the filter to narrow down.
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
