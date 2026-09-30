/**
 * Autodesk FBX Binary 7.4 writer.
 *
 * Implements the on-disk node tree described in the (unofficial) Blender
 * spec at https://code.blender.org/2013/08/fbx-binary-file-format-specification/
 * combined with the Autodesk SDK observed wire format. Output validates
 * against:
 *   - Blender 4.x  (FBX 7.4)
 *   - Autodesk FBX Review
 *   - 3ds Max 2024
 *   - Unity 2023+
 *
 * Why binary instead of ASCII?
 *   Blender's FBX importer flatly rejects ASCII files ("ASCII FBX files are
 *   not supported"). Maya/3ds Max accept both, but binary is the universally
 *   understood interchange format and is also 5–10× smaller.
 */
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Property model
// ---------------------------------------------------------------------------

export type FbxProp =
  | { type: "Y"; value: number } // int16
  | { type: "C"; value: boolean } // bool
  | { type: "I"; value: number } // int32
  | { type: "F"; value: number } // float32
  | { type: "D"; value: number } // float64
  | { type: "L"; value: bigint } // int64
  | { type: "R"; value: Uint8Array } // raw
  | { type: "S"; value: string } // string
  | { type: "f"; value: Float32Array }
  | { type: "d"; value: Float64Array }
  | { type: "l"; value: BigInt64Array }
  | { type: "i"; value: Int32Array }
  | { type: "b"; value: Uint8Array };

export interface FbxNode {
  name: string;
  props: FbxProp[];
  children: FbxNode[];
}

// Convenience constructors -------------------------------------------------

export const N = (
  name: string,
  props: FbxProp[] = [],
  children: FbxNode[] = [],
): FbxNode => ({ name, props, children });

export const I = (v: number): FbxProp => ({ type: "I", value: v | 0 });
export const D = (v: number): FbxProp => ({ type: "D", value: v });
export const F = (v: number): FbxProp => ({ type: "F", value: v });
export const C = (v: boolean): FbxProp => ({ type: "C", value: v });
export const S = (v: string): FbxProp => ({ type: "S", value: v });
export const L = (v: number | bigint): FbxProp => ({
  type: "L",
  value: typeof v === "bigint" ? v : BigInt(v),
});
export const dArr = (v: Float64Array | Float32Array | number[]): FbxProp => {
  if (v instanceof Float64Array) return { type: "d", value: v };
  if (v instanceof Float32Array)
    return { type: "d", value: Float64Array.from(v) };
  return { type: "d", value: Float64Array.from(v) };
};
export const iArr = (v: Int32Array | Uint32Array | number[]): FbxProp => {
  if (v instanceof Int32Array) return { type: "i", value: v };
  if (v instanceof Uint32Array) {
    const out = new Int32Array(v.length);
    for (let k = 0; k < v.length; k++) out[k] = v[k]! | 0;
    return { type: "i", value: out };
  }
  return { type: "i", value: Int32Array.from(v) };
};

/** P entry inside a Properties70 block. */
export const P = (
  name: string,
  type: string,
  subtype: string,
  flags: string,
  ...values: FbxProp[]
): FbxNode => N("P", [S(name), S(type), S(subtype), S(flags), ...values]);

/**
 * Build an FBX object identifier string with the binary-format separator.
 *
 * In **ASCII** FBX object headers look like `Geometry::Hull` (class then
 * "::" then name). In **binary** FBX the same field uses a single string
 * with the bytes `\x00\x01` between the *display name* (first) and the
 * *class name* (second) — i.e. the two halves are reversed AND the
 * separator differs.
 *
 * Blender's importer hard-codes `props[-2].split(b'\x00\x01')` and crashes
 * with "ValueError: not enough values to unpack" if the separator is
 * missing, so any Object header / cross-reference string MUST go through
 * this helper.
 */
export const NAME_CLASS_SEP = "\u0000\u0001";
export const objId = (displayName: string, className: string): string =>
  `${displayName}${NAME_CLASS_SEP}${className}`;

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

/** Above this raw byte size, encode arrays with zlib (deflate). */
const COMPRESS_THRESHOLD = 128;

function encodeArrayProp(
  typeChar: string,
  elemCount: number,
  raw: Buffer,
): Buffer {
  let encoding = 0;
  let data = raw;
  if (raw.length >= COMPRESS_THRESHOLD) {
    // FBX uses zlib-wrapped deflate (CMF/FLG header + adler32 trailer), NOT
    // raw deflate. Blender will reject the file with "Error -3 while
    // decompressing data: incorrect header check" if the 2-byte zlib header
    // is missing.
    const compressed = deflateSync(raw);
    if (compressed.length < raw.length) {
      encoding = 1;
      data = compressed;
    }
  }
  const out = Buffer.alloc(1 + 4 + 4 + 4 + data.length);
  out.writeUInt8(typeChar.charCodeAt(0), 0);
  out.writeUInt32LE(elemCount, 1);
  out.writeUInt32LE(encoding, 5);
  out.writeUInt32LE(data.length, 9);
  data.copy(out, 13);
  return out;
}

function encodeProp(p: FbxProp): Buffer {
  switch (p.type) {
    case "Y": {
      const b = Buffer.alloc(3);
      b.writeUInt8(0x59, 0);
      b.writeInt16LE(p.value, 1);
      return b;
    }
    case "C": {
      const b = Buffer.alloc(2);
      b.writeUInt8(0x43, 0);
      b.writeUInt8(p.value ? 1 : 0, 1);
      return b;
    }
    case "I": {
      const b = Buffer.alloc(5);
      b.writeUInt8(0x49, 0);
      b.writeInt32LE(p.value | 0, 1);
      return b;
    }
    case "F": {
      const b = Buffer.alloc(5);
      b.writeUInt8(0x46, 0);
      b.writeFloatLE(p.value, 1);
      return b;
    }
    case "D": {
      const b = Buffer.alloc(9);
      b.writeUInt8(0x44, 0);
      b.writeDoubleLE(p.value, 1);
      return b;
    }
    case "L": {
      const b = Buffer.alloc(9);
      b.writeUInt8(0x4c, 0);
      b.writeBigInt64LE(p.value, 1);
      return b;
    }
    case "S": {
      // Use 'binary' (latin1) encoding so that \u0000 → 0x00 and \u0001 → 0x01
      // are written as literal bytes. FBX binary strings are length-prefixed (not
      // NUL-terminated), so the \x00\x01 name/class separator must survive as raw
      // bytes. utf8 encodes \u0000 as \xc0\x80 (MUTF-8) in some Node.js builds,
      // which breaks Blender's elem_split_name_class b'\x00\x01' split.
      const data = Buffer.from(p.value, "binary");
      const b = Buffer.alloc(5 + data.length);
      b.writeUInt8(0x53, 0);
      b.writeUInt32LE(data.length, 1);
      data.copy(b, 5);
      return b;
    }
    case "R": {
      const b = Buffer.alloc(5 + p.value.length);
      b.writeUInt8(0x52, 0);
      b.writeUInt32LE(p.value.length, 1);
      Buffer.from(p.value).copy(b, 5);
      return b;
    }
    case "d":
      return encodeArrayProp(
        "d",
        p.value.length,
        Buffer.from(p.value.buffer, p.value.byteOffset, p.value.byteLength),
      );
    case "f":
      return encodeArrayProp(
        "f",
        p.value.length,
        Buffer.from(p.value.buffer, p.value.byteOffset, p.value.byteLength),
      );
    case "i":
      return encodeArrayProp(
        "i",
        p.value.length,
        Buffer.from(p.value.buffer, p.value.byteOffset, p.value.byteLength),
      );
    case "l":
      return encodeArrayProp(
        "l",
        p.value.length,
        Buffer.from(p.value.buffer, p.value.byteOffset, p.value.byteLength),
      );
    case "b":
      return encodeArrayProp("b", p.value.length, Buffer.from(p.value));
  }
}

/**
 * For FBX 7.4 (version < 7500) the node header uses 32-bit offsets and a
 * 13-byte sentinel; FBX 7.5+ widens to 64-bit + 25-byte sentinel.
 */
const NULL_RECORD = Buffer.alloc(13);

function encodeNode(node: FbxNode, offset: number): Buffer {
  const propBuffers = node.props.map(encodeProp);
  const propTotal = propBuffers.reduce((s, b) => s + b.length, 0);
  const nameBuf = Buffer.from(node.name, "utf8");
  const nameLen = nameBuf.length;
  if (nameLen > 255) {
    throw new Error(`FBX node name too long: ${node.name}`);
  }

  const headerSize = 4 + 4 + 4 + 1 + nameLen;
  const childrenStart = offset + headerSize + propTotal;

  const childBufs: Buffer[] = [];
  let cursor = childrenStart;
  for (const child of node.children) {
    const cb = encodeNode(child, cursor);
    childBufs.push(cb);
    cursor += cb.length;
  }
  const hasChildren = node.children.length > 0;
  // FBX requires a null-record sentinel after the child list. Per the FBX
  // SDK convention there are *three* cases to distinguish:
  //   1. Node has children            → emit children, then null sentinel
  //   2. Node has only properties     → no sentinel (pure leaf data carrier)
  //   3. Node has neither props nor children → emit a sentinel so the parser
  //      recognises this as an empty *container* (e.g. `Properties70 {}`,
  //      `References:  {}`) instead of treating it as malformed.
  const isEmpty = !hasChildren && node.props.length === 0;
  const needsSentinel = hasChildren || isEmpty;
  const childTotal =
    childBufs.reduce((s, b) => s + b.length, 0) +
    (needsSentinel ? NULL_RECORD.length : 0);

  const totalSize = headerSize + propTotal + childTotal;
  const endOffset = offset + totalSize;

  const buf = Buffer.alloc(totalSize);
  let p = 0;
  buf.writeUInt32LE(endOffset, p);
  p += 4;
  buf.writeUInt32LE(node.props.length, p);
  p += 4;
  buf.writeUInt32LE(propTotal, p);
  p += 4;
  buf.writeUInt8(nameLen, p);
  p += 1;
  nameBuf.copy(buf, p);
  p += nameLen;
  for (const pb of propBuffers) {
    pb.copy(buf, p);
    p += pb.length;
  }
  for (const cb of childBufs) {
    cb.copy(buf, p);
    p += cb.length;
  }
  // Trailing zero sentinel auto-filled by Buffer.alloc.
  return buf;
}

// ---------------------------------------------------------------------------
// File header / footer
// ---------------------------------------------------------------------------

const HEADER_MAGIC = Buffer.concat([
  Buffer.from("Kaydara FBX Binary  ", "binary"), // 20 bytes incl. trailing 2 spaces
  Buffer.from([0x00, 0x1a, 0x00]),
]);

/**
 * Footer constants observed in real Autodesk-emitted files. Contents are not
 * security-critical; modern importers ignore the footer code, but presence of
 * the trailing magic + version helps round-trip readers locate end of file.
 */
const FOOTER_CODE = Buffer.from([
  0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c,
  0xf7, 0x26, 0x7e,
]);
const FOOTER_MAGIC = Buffer.from([
  0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75,
  0x8f, 0x29, 0x0b,
]);

function buildFooter(version: number): Buffer {
  // 16 (footer code) + 4 (zero pad) + 4 (version) + 120 (zero pad) + 16 (magic)
  const buf = Buffer.alloc(160);
  FOOTER_CODE.copy(buf, 0);
  // 4 bytes zero @16
  buf.writeUInt32LE(version, 20);
  // 120 zeros @24..143
  FOOTER_MAGIC.copy(buf, 144);
  return buf;
}

/** Serialise a node tree to an FBX 7.4 binary buffer. */
export function encodeFbxBinary(
  rootChildren: FbxNode[],
  version = 7400,
): Buffer {
  const headerBuf = Buffer.alloc(HEADER_MAGIC.length + 4);
  HEADER_MAGIC.copy(headerBuf, 0);
  headerBuf.writeUInt32LE(version, HEADER_MAGIC.length);

  const nodeBuffers: Buffer[] = [];
  let offset = headerBuf.length;
  for (const node of rootChildren) {
    const nb = encodeNode(node, offset);
    nodeBuffers.push(nb);
    offset += nb.length;
  }

  return Buffer.concat([
    headerBuf,
    ...nodeBuffers,
    NULL_RECORD,
    buildFooter(version),
  ]);
}
