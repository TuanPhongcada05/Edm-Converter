import * as fs from "node:fs";
import { EdmReader, decodeWindows1251 } from "./src/lib/edm-reader";
import * as edmBody from "./src/lib/edm-body";

const file = process.argv[2] ?? "../../attached_assets/OSA_Two_1777464463085.edm";
const buf = fs.readFileSync(file);

// Locate TYPE_READERS via parseEdm by patching at the EdmReader prototype level.
// We hook every readUint() to compute a position-stamp; then we detect transitions
// by intercepting strings that match "model::ArgVisibilityNode" and tracking the
// next time the parser reads a top-level type (one that begins right after the
// previous one ended). Easier: patch the public `reads("model::ArgVisibilityNode", ...)` lambda.
// But TYPE_READERS is module-private. Use an indirection: monkey-patch readString to
// detect the "model::ArgVisibilityNode" string and snapshot position right after.

const origReadString = EdmReader.prototype.readString;
let lastVisStart = -1;

EdmReader.prototype.readString = function (lookup = true): string {
  const before = this.tell();
  const s = origReadString.call(this, lookup);
  if (s === "model::ArgVisibilityNode" && lookup) {
    lastVisStart = before;
    // Print whenever we end up at the NEXT typename read (any "::" string)
    // For now, print start; the end will be inferred from next "::" string.
    process.stdout.write(`\nVISIBILITY START @${before} `);
  } else if (lookup && s.includes("::") && lastVisStart >= 0) {
    // First "::" read after a Visibility start — record offset
    process.stdout.write(
      `next-internal=${s}@${before} (delta=${before - lastVisStart}) `,
    );
  }
  return s;
};

try {
  const r = edmBody.parseEdm(buf);
  console.log("\n\nOK, nodes:", r.nodes.length);
} catch (e) {
  console.log("\n\nFAILED:", (e as Error).message);
}
