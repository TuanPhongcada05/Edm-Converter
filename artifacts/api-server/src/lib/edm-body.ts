/**
 * EDM body parser. Ported from io_EDM v0.2.0 (types.py, material_types.py,
 * propertiesset.py, typereader.py).
 *
 * Layout of an EDM file (v10):
 *   - magic "EDM"                          (3 bytes)
 *   - version uint16 LE  (= 10)            (2 bytes)
 *   - stringSize uint32 LE                 (4 bytes)
 *   - strings blob (stringSize bytes, null-separated, windows-1251)
 *   - indexA  : { string_idx -> uint count }   <- type histogram (set 1)
 *   - indexB  : { string_idx -> uint count }   <- type histogram (set 2)
 *   - root    : named type "model::RootNode"
 *   - nodes   : list of named types (transform / animation hierarchy)
 *   - parents : int32[len(nodes)]   parent index per node, -1 = no parent
 *   - main object dictionary:
 *        count : uint32
 *        for each entry: string key + list of named types
 *        keys are CONNECTORS / RENDER_NODES / SHELL_NODES / LIGHT_NODES
 */

import { EdmReader, decodeWindows1251 } from "./edm-reader";

// =============================================================================
// Math types
// =============================================================================

export type Vec2f = [number, number];
export type Vec3f = [number, number, number];
export type Vec3d = [number, number, number];
/** Quaternion stored as [w, x, y, z]. */
export type Quat = [number, number, number, number];
/** 4x4 matrix as a flat 16-element array (column-major, OpenGL convention). */
export type Mat4 = number[];

// =============================================================================
// Material / vertex format
// =============================================================================

export interface VertexFormat {
  /** Raw per-channel byte array (variable length, typically 26). */
  data: number[];
  /** Number of position floats per vertex (channel 0). */
  nposition: number;
  /** Number of normal floats per vertex (channel 1). */
  nnormal: number;
  /** Number of texture-coord floats per vertex (channel 4). */
  ntexture: number;
}

export interface Texture {
  index: number;
  name: string;
  matrix: Mat4;
}

export interface Material {
  /** Sequential index in RootNode.materials. */
  index: number;
  blending?: number;
  culling?: number;
  depth_bias?: number;
  texture_coordinates_channels?: number[];
  material_name?: string;
  /** Display / shader name. */
  name?: string;
  shadows?: { cast: boolean; receive: boolean; cast_only: boolean };
  vertex_format?: VertexFormat;
  uniforms?: Record<string, unknown>;
  animated_uniforms?: Record<string, unknown>;
  textures?: Texture[];
}

function readVertexFormat(r: EdmReader): VertexFormat {
  const channels = r.readUint();
  const data = r.readUchars(channels);
  return {
    data,
    nposition: data[0] ?? 0,
    nnormal: data[1] ?? 0,
    ntexture: data[4] ?? 0,
  };
}

function readTexture(r: EdmReader): Texture {
  const index = r.readUint();
  const minus1 = r.readInt();
  if (minus1 !== -1) {
    throw new Error(
      `Texture: expected -1 separator, got ${minus1} at ${r.tell() - 4}`,
    );
  }
  const name = r.readString();
  const tag = r.readUints(4);
  if (!(tag[0] === 2 && tag[1] === 2 && tag[2] === 10 && tag[3] === 6)) {
    throw new Error(
      `Texture: expected (2,2,10,6) tag got (${tag.join(",")}) at ${r.tell() - 16}`,
    );
  }
  const matrix = r.readMatrixf();
  return { index, name, matrix };
}

const MATERIAL_ENTRY: Record<string, (r: EdmReader) => unknown> = {
  BLENDING: (r) => r.readUchar(),
  CULLING: (r) => r.readUchar(),
  DEPTH_BIAS: (r) => r.readUint(),
  TEXTURE_COORDINATES_CHANNELS: (r) => {
    const count = r.readUint();
    return r.readInts(count);
  },
  MATERIAL_NAME: (r) => r.readString(),
  NAME: (r) => r.readString(),
  SHADOWS: (r) => {
    const v = r.readUchar();
    return {
      cast: !!(v & 1),
      receive: !!(v & 2),
      cast_only: !!(v & 4),
    };
  },
  VERTEX_FORMAT: (r) => readVertexFormat(r),
  UNIFORMS: (r) => readPropertiesSet(r, true),
  ANIMATED_UNIFORMS: (r) => readAnimatedUniforms(r),
  TEXTURES: (r) => r.readList(readTexture),
};

function readMaterial(r: EdmReader): Material {
  const m: Material = { index: -1 };
  const count = r.readUint();
  for (let i = 0; i < count; i++) {
    const name = r.readString();
    const reader = MATERIAL_ENTRY[name];
    if (!reader) {
      throw new Error(
        `Unknown material entry "${name}" at offset ${r.tell() - 4}`,
      );
    }
    const value = reader(r);
    // Lower-case attribute name on the material object, matching Python.
    (m as unknown as Record<string, unknown>)[name.toLowerCase()] = value;
  }
  return m;
}

// =============================================================================
// PropertiesSet
// =============================================================================

/**
 * A PropertiesSet is a length-prefixed list of named-type properties. Each
 * property has the shape Property("name", value) — the dict result maps the
 * property name to the value. Animated properties are stored under their
 * "keys" attribute instead of "value".
 */
function readPropertiesSet(
  r: EdmReader,
  countTowardsAudit = true,
): Record<string, unknown> {
  const length = r.readUint();
  const data: Record<string, unknown> = {};
  for (let i = 0; i < length; i++) {
    const prop = readNamedType(r);
    if (
      prop &&
      typeof prop === "object" &&
      "name" in prop &&
      ("value" in prop || "keys" in prop)
    ) {
      const name = (prop as { name: string }).name;
      if ("keys" in prop) {
        data[name] = (prop as { keys: unknown }).keys;
      } else {
        data[name] = (prop as { value: unknown }).value;
      }
    }
  }
  if (length > 0 && countTowardsAudit) r.markTypeRead("model::PropertiesSet");
  return data;
}

function readAnimatedUniforms(r: EdmReader): Record<string, unknown> {
  const length = r.readUint();
  const data: Record<string, unknown> = {};
  for (let i = 0; i < length; i++) {
    const prop = readNamedType(r) as { name: string };
    data[prop.name] = prop;
  }
  return data;
}

// =============================================================================
// Type registry
// =============================================================================

type TypeReader = (r: EdmReader) => unknown;
const TYPE_READERS: Record<string, TypeReader> = {};

function reads(name: string, fn: TypeReader): void {
  TYPE_READERS[name] = (r) => {
    r.markTypeRead(name);
    return fn(r);
  };
}

/** Generate a Property<T> reader: name + value of registered type T. */
function registerProperty(typeName: string): void {
  reads(`model::Property<${typeName}>`, (r) => {
    const name = r.readString();
    const inner = TYPE_READERS[typeName];
    if (!inner) throw new Error(`No reader for inner type ${typeName}`);
    const value = inner(r);
    return { name, value };
  });
}

/** Generate a Key<keyName> reader: frame double + value of registered type. */
function registerKey(keyName: string, valueType: string): void {
  reads(`model::Key<${keyName}>`, (r) => {
    const frame = r.readDouble();
    const inner = TYPE_READERS[valueType];
    if (!inner) throw new Error(`No reader for key value type ${valueType}`);
    const value = inner(r);
    return { frame, value };
  });
}

/** Generate an AnimatedProperty<T> reader. */
function registerAnimatedProperty(typeName: string, keyName: string): void {
  reads(`model::AnimatedProperty<${typeName}>`, (r) => {
    const name = r.readString();
    const argument = r.readUint();
    const count = r.readUint();
    const inner = TYPE_READERS[`model::Key<${keyName}>`];
    if (!inner)
      throw new Error(`No reader for keyframe model::Key<${keyName}>`);
    const keys: unknown[] = [];
    for (let i = 0; i < count; i++) keys.push(inner(r));
    return { name, argument, keys };
  });
}

// --- primitive type readers ---
reads("unsigned int", (r) => r.readUint());
registerProperty("unsigned int");

reads("float", (r) => r.readFloat());
registerProperty("float");
registerKey("key::FLOAT", "float");
registerAnimatedProperty("float", "key::FLOAT");

reads("osg::Vec2f", (r) => r.readVec2f());
registerProperty("osg::Vec2f");
registerKey("key::VEC2F", "osg::Vec2f");
registerAnimatedProperty("osg::Vec2f", "key::VEC2F");

reads("osg::Vec3f", (r) => r.readVec3f());
registerProperty("osg::Vec3f");
registerKey("key::VEC3F", "osg::Vec3f");
registerAnimatedProperty("osg::Vec3f", "key::VEC3F");

reads("osg::Vec3d", (r) => r.readVec3d());
registerProperty("osg::Vec3d");

reads("osg::Matrixf", (r) => r.readMatrixf());
reads("osg::Matrixd", (r) => r.readMatrixd());
reads("osg::Quat", (r) => r.readQuaternion());

reads("const char*", (r) => r.readString());
registerProperty("const char*");

reads("model::ArgumentProperty", (r) => {
  const name = r.readString();
  const arg = r.readUint();
  return { name, argument: arg };
});

// --- node base ---

export interface BaseNodeData {
  typeName: string;
  name: string;
  version: number;
  props: Record<string, unknown>;
  /** Index assigned at parse time (root is "root"; others are 0..N). */
  index?: number;
  parentIndex?: number;
}

function readBaseNode(
  r: EdmReader,
  typeName: string,
): BaseNodeData & Record<string, unknown> {
  const name = r.readString(false); // length-prefixed even in v10
  const version = r.readUint();
  const props = readPropertiesSet(r, false);
  return { typeName, name, version, props };
}

// =============================================================================
// RootNode
// =============================================================================

export interface RootNode extends BaseNodeData {
  unknownA: number;
  boundingBoxMin: Vec3d;
  boundingBoxMax: Vec3d;
  unknownB: Vec3d[];
  materials: Material[];
  unknownD: number[];
}

reads("model::RootNode", (r) => {
  const base = readBaseNode(r, "model::RootNode");
  // v8 has a single uchar "unknownA" right after BaseNode; v10 does not.
  // Verified empirically against Tarantul_Corvette.EDM where skipping that
  // byte makes bboxMin land on a sensible double (-54.14, etc.) and the
  // first material's first entry resolves to string index 3 = "BLENDING".
  const unknownA = r.v8 ? r.readUchar() : 0;
  const boundingBoxMin = r.readVec3d();
  const boundingBoxMax = r.readVec3d();
  const unknownB: Vec3d[] = [];
  for (let i = 0; i < 4; i++) unknownB.push(r.readVec3d());
  const materials = r.readList(readMaterial);
  materials.forEach((m, i) => (m.index = i));
  const unknownD = r.readUints(2);
  const node: RootNode = {
    ...base,
    unknownA,
    boundingBoxMin,
    boundingBoxMax,
    unknownB,
    materials,
    unknownD,
  };
  return node;
});

// =============================================================================
// Transform / animation hierarchy nodes
// =============================================================================

reads("model::Node", (r) => readBaseNode(r, "model::Node"));

reads("model::TransformNode", (r) => {
  const base = readBaseNode(r, "model::TransformNode");
  const matrix = r.readMatrixd();
  return { ...base, matrix };
});

reads("model::Bone", (r) => {
  const base = readBaseNode(r, "model::Bone");
  const matrices = [r.readMatrixd(), r.readMatrixd()];
  return { ...base, matrices };
});

interface ArgAnimationBase {
  matrix: Mat4;
  position: Vec3d;
  quat_1: Quat;
  quat_2: Quat;
  scale: Vec3d;
}

function readArgAnimationBase(r: EdmReader): ArgAnimationBase {
  return {
    matrix: r.readMatrixd(),
    position: r.readVec3d(),
    quat_1: r.readQuaternion(),
    quat_2: r.readQuaternion(),
    scale: r.readVec3d(),
  };
}

function readPosArg(r: EdmReader): unknown {
  r.markTypeRead("model::ArgAnimationNode::Position");
  const arg = r.readUint();
  const count = r.readUint();
  const keys: { frame: number; value: Vec3d }[] = [];
  for (let i = 0; i < count; i++) {
    keys.push({ frame: r.readDouble(), value: r.readVec3d() });
  }
  r.markTypeRead("model::Key<key::POSITION>", count);
  return [arg, keys];
}

function readRotArg(r: EdmReader): unknown {
  r.markTypeRead("model::ArgAnimationNode::Rotation");
  const arg = r.readUint();
  const count = r.readUint();
  const keys: { frame: number; value: Quat }[] = [];
  for (let i = 0; i < count; i++) {
    keys.push({ frame: r.readDouble(), value: r.readQuaternion() });
  }
  r.markTypeRead("model::Key<key::ROTATION>", count);
  return [arg, keys];
}

function readScaleArg(r: EdmReader): unknown {
  r.markTypeRead("model::ArgAnimationNode::Scale");
  const arg = r.readUint();
  const count = r.readUint();
  const keys1: { frame: number; value: number[] }[] = [];
  for (let i = 0; i < count; i++) {
    keys1.push({ frame: r.readDouble(), value: Array.from(r.readDoubles(4)) });
  }
  const count2 = r.readUint();
  const keys2: { frame: number; value: number[] }[] = [];
  for (let i = 0; i < count2; i++) {
    keys2.push({ frame: r.readDouble(), value: Array.from(r.readDoubles(3)) });
  }
  r.markTypeRead("model::Key<key::SCALE>", count + count2);
  return [arg, [keys1, keys2]];
}

function readArgAnimation(
  r: EdmReader,
  typeName: string,
): Record<string, unknown> {
  const base = readBaseNode(r, typeName);
  const animBase = readArgAnimationBase(r);
  const posData = r.readList(readPosArg);
  const rotData = r.readList(readRotArg);
  const scaleData = r.readList(readScaleArg);
  return { ...base, animBase, posData, rotData, scaleData };
}

reads("model::ArgAnimationNode", (r) =>
  readArgAnimation(r, "model::ArgAnimationNode"),
);
reads("model::ArgAnimatedBone", (r) => {
  const base = readArgAnimation(r, "model::ArgAnimatedBone");
  r.markTypeRead("model::ArgAnimationNode");
  const boneTransform = r.readMatrixd();
  return { ...base, boneTransform };
});
reads("model::ArgRotationNode", (r) => {
  r.markTypeRead("model::ArgAnimationNode");
  return readArgAnimation(r, "model::ArgRotationNode");
});
reads("model::ArgPositionNode", (r) => {
  r.markTypeRead("model::ArgAnimationNode");
  return readArgAnimation(r, "model::ArgPositionNode");
});
reads("model::ArgScaleNode", (r) => {
  r.markTypeRead("model::ArgAnimationNode");
  return readArgAnimation(r, "model::ArgScaleNode");
});

reads("model::ArgVisibilityNode", (r) => {
  const base = readBaseNode(r, "model::ArgVisibilityNode");
  const visData = r.readList((rr) => {
    rr.markTypeRead("model::ArgVisibilityNode::Arg");
    const arg = rr.readUint();
    const count = rr.readUint();
    const data: number[][] = [];
    for (let i = 0; i < count; i++) data.push(Array.from(rr.readDoubles(2)));
    rr.markTypeRead("model::ArgVisibilityNode::Range", count);
    return [arg, data];
  });
  // DCS appends a 4×4 float matrix only when the node carries a
  // `__VERSION__` property of >= 1 (e.g. Tarantul_Corvette's LIGHT nodes).
  // Older OSA-class files declare no `__VERSION__` and omit the matrix —
  // attempting to read it then desyncs the parser at the next typename.
  const versionProp = (base.props as Record<string, unknown>)["__VERSION__"];
  const nodeVersion =
    typeof versionProp === "number" ? versionProp : 0;
  let matrix: number[] | undefined;
  if (nodeVersion >= 1) {
    matrix = r.readMatrixf();
  }
  return { ...base, visData, matrix, nodeVersion };
});

reads("model::LodNode", (r) => {
  const base = readBaseNode(r, "model::LodNode");
  const count = r.readUint();
  const level: { low: number; high: number }[] = [];
  for (let i = 0; i < count; i++) {
    const a = r.readDouble();
    const b = r.readDouble();
    level.push({ low: Math.sqrt(a), high: Math.sqrt(b) });
  }
  r.markTypeRead("model::LodNode::Level", count);
  return { ...base, level };
});

// =============================================================================
// Render objects (CONNECTORS, RENDER_NODES, SHELL_NODES, LIGHT_NODES)
// =============================================================================

export interface Connector extends BaseNodeData {
  parent: number;
  data: number;
}

reads("model::Connector", (r) => {
  const base = readBaseNode(r, "model::Connector");
  const parent = r.readUint();
  const data = r.readUint();
  return { ...base, parent, data };
});

interface IndexBlock {
  unknown: number;
  data: number[];
  /** Width of each index in bytes (1, 2 or 4). */
  width: 1 | 2 | 4;
}

function readIndexData(
  r: EdmReader,
  classification: string | null,
): IndexBlock {
  const dtPos = r.tell();
  const dataType = r.readUchar();
  const entries = r.readUint();
  const unknown = r.readUint();
  let data: number[];
  let bytes: number;
  let width: 1 | 2 | 4;
  if (dataType === 0) {
    data = r.readUchars(entries);
    bytes = entries;
    width = 1;
  } else if (dataType === 1) {
    data = r.readUshorts(entries);
    bytes = entries * 2;
    width = 2;
  } else if (dataType === 2) {
    data = r.readUints(entries);
    bytes = entries * 4;
    width = 4;
  } else {
    throw new Error(
      `Unknown index data type ${dataType} at offset ${dtPos}`,
    );
  }
  if (classification) r.markTypeRead(classification, bytes);
  return { unknown, data, width };
}

interface VertexBlock {
  /** Number of vertices. */
  count: number;
  /** Floats per vertex. */
  stride: number;
  /** Flat float array, length = count * stride. */
  data: Float32Array;
}

function readVertexData(
  r: EdmReader,
  classification: string | null,
): VertexBlock {
  const count = r.readUint();
  const stride = r.readUint();
  const data = r.readFloats(count * stride);
  if (classification) r.markTypeRead(classification, count * stride * 4);
  return { count, stride, data };
}

function readParentData(r: EdmReader): number[][] {
  const parentCount = r.readUint();
  r.markTypeRead("model::RNControlNode", Math.max(0, parentCount - 1));
  if (parentCount === 1) {
    const node = r.readUint();
    const arg = r.readInt();
    return [[node, arg]];
  }
  const out: number[][] = [];
  for (let i = 0; i < parentCount; i++) {
    const node = r.readUint();
    const a = r.readInt();
    const b = r.readInt();
    out.push([node, a, b]);
  }
  return out;
}

export interface RenderNode extends BaseNodeData {
  unknownStart: number;
  /** Material index in RootNode.materials (resolved post-parse). */
  material: number;
  parentData: number[][];
  vertex: VertexBlock;
  indexBuffer: IndexBlock;
}

reads("model::RenderNode", (r) => {
  const base = readBaseNode(r, "model::RenderNode");
  const unknownStart = r.readUint();
  const material = r.readUint();
  const parentData = readParentData(r);
  const vertex = readVertexData(r, "__gv_bytes");
  const indexBuffer = readIndexData(r, "__gi_bytes");
  return { ...base, unknownStart, material, parentData, vertex, indexBuffer };
});

export interface ShellNode extends BaseNodeData {
  parent: number;
  vertexFormat: VertexFormat;
  vertex: VertexBlock;
  indexBuffer: IndexBlock;
}

reads("model::ShellNode", (r) => {
  const base = readBaseNode(r, "model::ShellNode");
  const parent = r.readUint();
  const vertexFormat = readVertexFormat(r);
  const vertex = readVertexData(r, "__cv_bytes");
  const indexBuffer = readIndexData(r, "__ci_bytes");
  return { ...base, parent, vertexFormat, vertex, indexBuffer };
});

reads("model::SkinNode", (r) => {
  const base = readBaseNode(r, "model::SkinNode");
  const unknown = r.readUint();
  const material = r.readUint();
  const boneCount = r.readUint();
  const bones = r.readUints(boneCount);
  const postBone = r.readUint();
  const vertex = readVertexData(r, "__gv_bytes");
  const index = readIndexData(r, "__gi_bytes");
  return { ...base, unknown, material, bones, postBone, vertex, index };
});

reads("model::SegmentsNode", (r) => {
  const base = readBaseNode(r, "model::SegmentsNode");
  const unknown = r.readUint();
  const count = r.readUint();
  const data: Float32Array[] = [];
  for (let i = 0; i < count; i++) data.push(r.readFloats(6));
  r.markTypeRead("model::SegmentsNode::Segments", count);
  return { ...base, unknown, data };
});

reads("model::BillboardNode", (r) => {
  const base = readBaseNode(r, "model::BillboardNode");
  const data = r.read(154);
  return { ...base, data };
});

reads("model::LightNode", (r) => {
  const base = readBaseNode(r, "model::LightNode");
  const parent = r.readUint();
  const u1 = r.readUchar();
  const lightProps = readPropertiesSet(r, false);
  const u2 = r.readUchar();
  return { ...base, parent, unknown: [u1, u2], lightProps };
});

reads("model::FakeSpotLightsNode", (r) => {
  const base = readBaseNode(r, "model::FakeSpotLightsNode");
  const unknownStart = r.readUint();
  const materialIsh = r.readUint();
  const controlNodeCount = r.readUint();
  const parentData: unknown[] = [];
  for (let i = 0; i < controlNodeCount; i++) {
    parentData.push([r.readUint(), r.readUint(), r.readFloats(3)]);
  }
  if (controlNodeCount > 0)
    r.markTypeRead("model::FSLNControlNode", controlNodeCount - 1);
  const dataCount = r.readUint();
  const data: Buffer[] = [];
  for (let i = 0; i < dataCount; i++) data.push(r.read(65));
  r.markTypeRead("model::FakeSpotLight", dataCount);
  return { ...base, unknownStart, materialIsh, parentData, data };
});

reads("model::FakeOmniLightsNode", (r) => {
  const base = readBaseNode(r, "model::FakeOmniLightsNode");
  const dataStart = r.readUints(5);
  const count = r.readUint();
  const data: Float64Array[] = [];
  for (let i = 0; i < count; i++) data.push(r.readDoubles(6));
  r.markTypeRead("model::FakeOmniLight", count);
  return { ...base, dataStart, data };
});

reads("model::FakeALSNode", (r) => {
  const base = readBaseNode(r, "model::FakeALSNode");
  r.readUints(3);
  const count = r.readUint();
  const data: Buffer[] = [];
  for (let i = 0; i < count; i++) data.push(r.read(80));
  r.markTypeRead("model::FakeALSLight", count);
  return { ...base, data };
});

// =============================================================================
// Top-level parsing
// =============================================================================

function readNamedType(r: EdmReader): unknown {
  const typeName = r.readString();
  const reader = TYPE_READERS[typeName];
  if (!reader) {
    throw new Error(
      `No reader registered for type "${typeName}" at offset ${r.tell() - 4}`,
    );
  }
  return reader(r);
}

function readIndex(r: EdmReader): Record<string, number> {
  const length = r.readUint();
  const out: Record<string, number> = {};
  for (let i = 0; i < length; i++) {
    const key = r.readString();
    const value = r.readUint();
    out[key] = value;
  }
  return out;
}

export interface ParsedEdmFile {
  version: 8 | 10;
  stringTable: string[];
  /** Byte size of strings blob (v10) or 0 for v8. */
  stringBlobSize: number;
  /** File offset where the body starts (after header + string table). */
  bodyStart: number;
  indexA: Record<string, number>;
  indexB: Record<string, number>;
  /** Raw root node object. */
  root: RootNode;
  /** Transform / animation nodes in declaration order. */
  nodes: BaseNodeData[];
  /** parents[i] is index into nodes[] (or -1). */
  parents: number[];
  connectors: Connector[];
  renderNodes: RenderNode[];
  shellNodes: ShellNode[];
  lightNodes: BaseNodeData[];
  /** Per-typename audit counts gathered by the reader. */
  typeCount: Record<string, number>;
  /** Unparsed trailing bytes count (should be 0 on a clean parse). */
  trailingBytes: number;
}

export function parseEdm(buf: Buffer): ParsedEdmFile {
  const r = new EdmReader(buf);
  r.readConstant("EDM");
  const version = r.readUshort();
  if (version !== 8 && version !== 10) {
    throw new Error(`Unsupported EDM version ${version}`);
  }
  r.version = version;

  let stringBlobSize = 0;
  if (r.v10) {
    stringBlobSize = r.readUint();
    const blob = r.read(stringBlobSize);
    // Strings are null-separated; the blob ends with a trailing null which
    // produces a final empty string we keep so indices line up.
    const decoded = decodeWindows1251(blob);
    r.strings = decoded.split("\0");
  }

  const bodyStart = r.tell();
  const indexA = readIndex(r);
  const indexB = readIndex(r);

  const root = readNamedType(r) as RootNode;
  root.index = -1;

  const nodeCount = r.readUint();
  const nodes: BaseNodeData[] = [];
  for (let _ni = 0; _ni < nodeCount; _ni++) {
    nodes.push(readNamedType(r) as BaseNodeData);
  }
  nodes.forEach((n, i) => (n.index = i));

  const parents = r.readInts(nodes.length);
  parents.forEach((p, i) => {
    if (p !== -1 && nodes[i]) nodes[i]!.parentIndex = p;
  });

  // Main object dictionary
  const objCount = r.readUint();
  let connectors: Connector[] = [];
  let renderNodes: RenderNode[] = [];
  let shellNodes: ShellNode[] = [];
  let lightNodes: BaseNodeData[] = [];
  for (let i = 0; i < objCount; i++) {
    const key = r.readString();
    const list = r.readList(readNamedType);
    if (key === "CONNECTORS") connectors = list as Connector[];
    else if (key === "RENDER_NODES") renderNodes = list as RenderNode[];
    else if (key === "SHELL_NODES") shellNodes = list as ShellNode[];
    else if (key === "LIGHT_NODES") lightNodes = list as BaseNodeData[];
  }

  const trailingBytes = r.remaining();
  const typeCount: Record<string, number> = {};
  for (const [k, v] of r.typeCount) typeCount[k] = v;

  return {
    version: version as 8 | 10,
    stringTable: r.strings ?? [],
    stringBlobSize,
    bodyStart,
    indexA,
    indexB,
    root,
    nodes,
    parents,
    connectors,
    renderNodes,
    shellNodes,
    lightNodes,
    typeCount,
    trailingBytes,
  };
}
