/**
 * Low-level binary reader for EDM v8/v10 files.
 * Ported from io_EDM/edm/basereader.py (v0.2.0).
 *
 * All numeric reads are little-endian. The v10 format uses a string lookup
 * table at the start of the file: read_string(lookup=true) returns
 * strings[uint32_index], whereas read_string(lookup=false) is always the
 * length-prefixed (uint32 length + bytes) form.
 *
 * This implementation uses a single in-memory Buffer with a mutable cursor.
 */

export type EdmVersion = 8 | 10;

export class EdmReader {
  buf: Buffer;
  pos = 0;
  version: EdmVersion = 8;
  strings: string[] | null = null;

  // Per-typename counters used for audit / debugging.
  typeCount = new Map<string, number>();

  constructor(buf: Buffer) {
    this.buf = buf;
  }

  get v8(): boolean {
    return this.version === 8;
  }

  get v10(): boolean {
    return this.version === 10;
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  tell(): number {
    return this.pos;
  }

  seek(offset: number): void {
    this.pos = offset;
  }

  read(length: number): Buffer {
    const out = this.buf.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  readConstant(expected: Buffer | string): void {
    const expBuf =
      typeof expected === "string" ? Buffer.from(expected, "ascii") : expected;
    const got = this.read(expBuf.length);
    if (!got.equals(expBuf)) {
      throw new Error(
        `Expected constant ${expBuf.toString("hex")} but got ${got.toString("hex")} at ${this.pos - expBuf.length}`,
      );
    }
  }

  readUchar(): number {
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }

  readUchars(count: number): number[] {
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) out[i] = this.buf.readUInt8(this.pos + i);
    this.pos += count;
    return out;
  }

  readUshort(): number {
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }

  readUshorts(count: number): number[] {
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++)
      out[i] = this.buf.readUInt16LE(this.pos + i * 2);
    this.pos += count * 2;
    return out;
  }

  readUint(): number {
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readUints(count: number): number[] {
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++)
      out[i] = this.buf.readUInt32LE(this.pos + i * 4);
    this.pos += count * 4;
    return out;
  }

  readInt(): number {
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }

  readInts(count: number): number[] {
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++)
      out[i] = this.buf.readInt32LE(this.pos + i * 4);
    this.pos += count * 4;
    return out;
  }

  readFloat(): number {
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }

  readFloats(count: number): Float32Array {
    // Copy via DataView to avoid alignment issues.
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++)
      out[i] = this.buf.readFloatLE(this.pos + i * 4);
    this.pos += count * 4;
    return out;
  }

  readDouble(): number {
    const v = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return v;
  }

  readDoubles(count: number): Float64Array {
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++)
      out[i] = this.buf.readDoubleLE(this.pos + i * 8);
    this.pos += count * 8;
    return out;
  }

  /**
   * Read a string. In v10 with lookup=true (default), reads a uint32 index
   * into the pre-loaded string table. Otherwise reads a uint32 length-prefix
   * followed by `length` bytes (windows-1251 decoded).
   */
  readString(lookup = true): string {
    const prepos = this.pos;
    if (this.v10 && lookup) {
      const idx = this.readUint();
      if (!this.strings || idx >= this.strings.length) {
        throw new Error(
          `String lookup index ${idx} out of range (table size ${this.strings?.length ?? 0}) at offset ${prepos}`,
        );
      }
      return this.strings[idx]!;
    }
    const length = this.readUint();
    if (length > 1024) {
      throw new Error(
        `Suspiciously long string length ${length} at offset ${prepos}`,
      );
    }
    const data = this.read(length);
    return decodeWindows1251(data);
  }

  readVec2f(): [number, number] {
    return [this.readFloat(), this.readFloat()];
  }

  readVec3f(): [number, number, number] {
    return [this.readFloat(), this.readFloat(), this.readFloat()];
  }

  readVec3d(): [number, number, number] {
    return [this.readDouble(), this.readDouble(), this.readDouble()];
  }

  /** Read 16 floats (column-major OpenGL matrix). */
  readMatrixf(): number[] {
    return Array.from(this.readFloats(16));
  }

  readMatrixd(): number[] {
    return Array.from(this.readDoubles(16));
  }

  /**
   * OSG saves quaternions as xyzw doubles. Reorder to wxyz to match the
   * reference Python parser's convention.
   */
  readQuaternion(): [number, number, number, number] {
    const q = this.readDoubles(4);
    return [q[3]!, q[0]!, q[1]!, q[2]!];
  }

  readList<T>(reader: (r: EdmReader) => T): T[] {
    const length = this.readUint();
    const out = new Array<T>(length);
    for (let i = 0; i < length; i++) out[i] = reader(this);
    return out;
  }

  markTypeRead(name: string, amount = 1): void {
    this.typeCount.set(name, (this.typeCount.get(name) ?? 0) + amount);
  }
}

/**
 * Decode a Buffer as windows-1251. We implement this manually rather than
 * pulling in iconv-lite — this is the only place we need it and the mapping
 * is straightforward (high-half map of 128 codepoints).
 */
const WIN1251_HIGH: string = (() => {
  // Source: official cp1251 mapping (0x80..0xFF). Undefined slots map to U+FFFD.
  const map = [
    0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac,
    0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f, 0x0452, 0x2018,
    0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0xfffd, 0x2122, 0x0459,
    0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408,
    0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac,
    0x00ad, 0x00ae, 0x0407, 0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5,
    0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455,
    0x0457, 0x0410, 0x0411, 0x0412, 0x0413, 0x0414, 0x0415, 0x0416, 0x0417,
    0x0418, 0x0419, 0x041a, 0x041b, 0x041c, 0x041d, 0x041e, 0x041f, 0x0420,
    0x0421, 0x0422, 0x0423, 0x0424, 0x0425, 0x0426, 0x0427, 0x0428, 0x0429,
    0x042a, 0x042b, 0x042c, 0x042d, 0x042e, 0x042f, 0x0430, 0x0431, 0x0432,
    0x0433, 0x0434, 0x0435, 0x0436, 0x0437, 0x0438, 0x0439, 0x043a, 0x043b,
    0x043c, 0x043d, 0x043e, 0x043f, 0x0440, 0x0441, 0x0442, 0x0443, 0x0444,
    0x0445, 0x0446, 0x0447, 0x0448, 0x0449, 0x044a, 0x044b, 0x044c, 0x044d,
    0x044e, 0x044f,
  ];
  return map.map((cp) => String.fromCodePoint(cp)).join("");
})();

export function decodeWindows1251(buf: Buffer): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b < 0x80) out += String.fromCharCode(b);
    else out += WIN1251_HIGH[b - 0x80] ?? "\uFFFD";
  }
  return out;
}
