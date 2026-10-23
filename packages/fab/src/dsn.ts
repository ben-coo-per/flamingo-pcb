/**
 * Flamingo Fab - Specctra DSN export
 *
 * Emits a Specctra `.dsn` design file for the Freerouting autorouter.
 *
 * Units / coordinates: all DSN numbers are plain micrometre (µm) integers
 * (mm x 1000, rounded). We declare `(resolution um 1)` so 1 coordinate unit
 * == 1 µm — lossless at 1 µm and trivially readable. Specctra is y-up like
 * our engine, so coordinates pass through with NO y-flip.
 *
 * Bottom-side components: emitted as `(place ... back <rot>)`. Specctra
 * mirrors the component image across its local Y axis (x -> -x) for back-side
 * placement, which matches our engine's bottom-side convention
 * (componentTransformPoints: mirror x, then rotate, then translate). The
 * `(place ...)` origin itself is NOT mirrored (Specctra mirrors around it) —
 * asserted in test/dsn.test.ts. The end-to-end convention match is verified
 * for real against freerouting by the bottom-side round-trip in
 * packages/server/test/route.integration.test.ts (a back-side SOT-23 with
 * asymmetric pads + nonzero rotation routes to our computed pad anchors).
 *
 * Padstacks are defined in footprint-local ("as-if front") layers: a
 * footprint-local `top` pad puts copper on F.Cu, `bottom` on B.Cu, `through`
 * on every copper layer. Specctra's back-side mirror flips F.Cu <-> B.Cu for
 * back-side components, so the image itself stays side-independent.
 */

import { createRequire } from 'node:module';
import type { Board, ComponentInst, LayerId, Net, NetClass, Pad, Point, Track } from '@flamingo/engine';
import {
  copperLayersOf,
  boardBBox,
  outlineToPolygon,
  padOutline,
  RULESETS,
  allHoles,
  holeSlotCenterline,
  capsulePolygon,
} from '@flamingo/engine';

const HOST_CAD = 'flamingo';
const HOST_VERSION = createRequire(import.meta.url)('../package.json').version as string;

export interface ExportDSNOptions {
  /**
   * If given, only these nets are handed to the router as things to route.
   * Every net (routable or not) is still declared in `(network)`/`(class)`
   * with its real class rules -- otherwise an excluded net's protect wiring
   * would reference an undeclared net and fall back to the board's default
   * clearance instead of its own. Every OTHER net's existing tracks/vias are
   * emitted in `(wiring)` as `(type protect)` obstacles so the router
   * respects them. If omitted, the full board is routed and no wiring is
   * written (a fresh route of everything).
   */
  nets?: string[];
  /** With `nets`: also emit the listed nets' own existing tracks/vias as protected wiring (pre-routed fanout the router must keep and connect to). */
  keep?: boolean;
}

// ---------------------------------------------------------------------------
// Number / token formatting
// ---------------------------------------------------------------------------

/** mm -> integer micrometres (normalising -0 to 0). */
function um(mm: number): number {
  return Math.round(mm * 1000) + 0;
}

/** Does a token need to be double-quoted in DSN output? */
function needsQuote(s: string): boolean {
  return s.length === 0 || /[\s()"]/.test(s);
}

/** Quote a token if necessary (net names / ids with spaces etc.). */
function tok(s: string): string {
  return needsQuote(s) ? `"${s}"` : s;
}

/**
 * A `REFDES.PAD` pin ref as the Specctra `component-pin` pair. Refdes and pad
 * number are quoted independently so a pad name with a space/paren can't
 * split into extra tokens, and so a refdes or pad name containing `-` can't
 * be confused with the pair's own `-` separator.
 */
function pinRefTok(ref: string): string {
  const i = ref.indexOf('.');
  const refdes = i >= 0 ? ref.slice(0, i) : ref;
  const pad = i >= 0 ? ref.slice(i + 1) : '';
  const q = (s: string): string => (needsQuote(s) || s.includes('-') ? `"${s}"` : s);
  return `${q(refdes)}-${q(pad)}`;
}

// ---------------------------------------------------------------------------
// Stable hashing (for polygon padstack names)
// ---------------------------------------------------------------------------

function hash8(s: string): string {
  // FNV-1a 32-bit, hex.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Padstack modelling
// ---------------------------------------------------------------------------

/** Footprint-local copper layers a pad occupies ("as-if front"). */
function padStackLayers(b: Board, pad: Pad): LayerId[] {
  if (pad.layer === 'through') return copperLayersOf(b);
  return [pad.layer === 'top' ? 'F.Cu' : 'B.Cu'];
}

function layerTag(pad: Pad): string {
  if (pad.layer === 'through') return 'TH';
  return pad.layer === 'top' ? 'F' : 'B';
}

/** Pad outline centred at the pad origin, with pad.rotation baked in. */
function padLocalShape(pad: Pad): Point[] {
  const idComp: ComponentInst = {
    refdes: '',
    lcsc: '',
    footprint: { name: '', lcsc: '', pads: [], silk: [], courtyard: [] },
    at: { x: 0, y: 0 },
    rotation: 0,
    side: 'top',
    fields: {},
  };
  return padOutline(idComp, pad).map((p) => ({ x: p.x - pad.at.x, y: p.y - pad.at.y }));
}

interface PadStack {
  name: string;
  /** shape forms already indented by the caller, one per layer. */
  shapeForms: string[];
}

/**
 * Compute the padstack name + per-layer shape forms for a pad. The name is a
 * pure function of (shape, w, h, drill, layer-side), so two pads with the same
 * geometry produce the same name and dedupe to one padstack.
 */
function padStackFor(b: Board, pad: Pad): PadStack {
  const layers = padStackLayers(b, pad);
  const tag = layerTag(pad);
  const drillTag = pad.drill ? `_d${um(pad.drill.diameter)}` : '';
  const w = um(pad.size.w);
  const h = um(pad.size.h);
  const rotMod = ((pad.rotation % 180) + 180) % 180;
  const rotated = Math.abs(rotMod) > 1e-6;

  let name: string;
  let form: (layer: LayerId) => string;

  if (pad.shape === 'circle') {
    name = `circle_${w}${drillTag}_${tag}`;
    form = (layer) => `(circle ${layer} ${w})`;
  } else if (pad.shape === 'polygon' || rotated) {
    const pts = padLocalShape(pad);
    const coords = pts.map((p) => `${um(p.x)} ${um(p.y)}`).join(' ');
    name = `poly_${hash8(`${coords}|${tag}${drillTag}`)}_${tag}`;
    form = (layer) => `(polygon ${layer} 0 ${coords})`;
  } else if (pad.shape === 'rect') {
    name = `rect_${w}x${h}${drillTag}_${tag}`;
    const x1 = um(-pad.size.w / 2);
    const y1 = um(-pad.size.h / 2);
    const x2 = um(pad.size.w / 2);
    const y2 = um(pad.size.h / 2);
    form = (layer) => `(rect ${layer} ${x1} ${y1} ${x2} ${y2})`;
  } else {
    // oval, axis-aligned: represent as a stroked path (stadium).
    name = `oval_${w}x${h}${drillTag}_${tag}`;
    const width = Math.min(w, h);
    const long = Math.max(w, h) - width;
    const half = Math.round(long / 2);
    const line =
      w >= h ? `${-half} 0 ${half} 0` : `0 ${-half} 0 ${half}`;
    form = (layer) => `(path ${layer} ${width} ${line})`;
  }

  const shapeForms = layers.map((layer) => `(shape ${form(layer)})`);
  return { name, shapeForms };
}

/** Via padstack name from drill/diameter (µm), e.g. V_300_600. */
function viaPadStackName(drillMm: number, diaMm: number): string {
  return `V_${um(drillMm)}_${um(diaMm)}`;
}

function viaPadStackForms(b: Board, diaMm: number): string[] {
  const dia = um(diaMm);
  return copperLayersOf(b).map((layer) => `(shape (circle ${layer} ${dia}))`);
}

// ---------------------------------------------------------------------------
// Track path tessellation (for protect wiring)
// ---------------------------------------------------------------------------

function trackPoints(t: Track): Point[] {
  const seg = t.seg;
  if (seg.type === 'line') return [seg.start, seg.end];
  // Arc: tessellate into a polyline (obstacle approximation for protect wires).
  const { start, end, center, cw } = seg;
  const r = Math.hypot(start.x - center.x, start.y - center.y);
  const a0 = Math.atan2(start.y - center.y, start.x - center.x);
  const a1 = Math.atan2(end.y - center.y, end.x - center.x);
  const twoPi = 2 * Math.PI;
  let sweep = cw ? (((a0 - a1) % twoPi) + twoPi) % twoPi : (((a1 - a0) % twoPi) + twoPi) % twoPi;
  if (sweep < 1e-12) sweep = twoPi;
  const steps = Math.max(2, Math.ceil((sweep * r) / 0.2));
  const pts: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = cw ? a0 - (sweep * i) / steps : a0 + (sweep * i) / steps;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Board boundary
// ---------------------------------------------------------------------------

function boundaryPath(b: Board): string {
  let pts: Point[];
  if (b.outline.length > 0) {
    pts = outlineToPolygon(b.outline);
  } else {
    const bb = boardBBox(b);
    pts = [
      { x: bb.minX, y: bb.minY },
      { x: bb.maxX, y: bb.minY },
      { x: bb.maxX, y: bb.maxY },
      { x: bb.minX, y: bb.maxY },
    ];
  }
  const nums: number[] = [];
  for (const p of pts) nums.push(um(p.x), um(p.y));
  // close the ring
  nums.push(um(pts[0].x), um(pts[0].y));
  return `(path pcb 0 ${nums.join(' ')})`;
}

// ---------------------------------------------------------------------------
// Net class resolution
// ---------------------------------------------------------------------------

/** Hard-coded fallback net class when the board declares no `default`. */
const FALLBACK_NET_CLASS: NetClass = {
  name: 'default',
  trackWidth: 0.25,
  clearance: 0.2,
  viaDrill: 0.3,
  viaDiameter: 0.6,
};

function netClassOf(b: Board, net: Net): NetClass {
  return (
    b.netClasses.find((c) => c.name === net.class) ??
    b.netClasses.find((c) => c.name === 'default') ??
    FALLBACK_NET_CLASS
  );
}

function defaultNetClass(b: Board): NetClass {
  return b.netClasses.find((c) => c.name === 'default') ?? FALLBACK_NET_CLASS;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportDSN(b: Board, opts: ExportDSNOptions = {}): string {
  const nets = opts.nets;
  const includeNet = (name: string): boolean => (nets ? nets.includes(name) : true);

  // Nets that go into the (network) section: every routable (>=2 pins) net,
  // included or not -- an excluded net's protect wiring still needs its own
  // declared net/class so it gets its real clearance instead of the board
  // default (see ExportDSNOptions.nets above).
  const networkNets = b.nets.filter((n) => n.pins.length >= 2);

  // ---- Images (deduped by footprint name + a hash of the pad geometry, so
  // two parts that happen to share a (sometimes empty) footprint name but
  // have different real pads -- e.g. both just called "0603" -- get distinct
  // images instead of silently sharing the first one's pads). The bare name
  // is kept as the DSN image id for the first geometry seen under it; only a
  // later, distinct geometry under the same name gets a disambiguating
  // suffix, so the common (single-geometry) case is untouched. ----
  const imageOrder: string[] = [];
  const imageByToken = new Map<string, ComponentInst>();
  const imageTokenOf = new Map<ComponentInst, string>();
  const tokensByName = new Map<string, Map<string, string>>(); // name -> (padHash -> token)
  for (const c of b.components) {
    const name = c.footprint.name;
    const padHash = hash8(JSON.stringify(c.footprint.pads));
    let byHash = tokensByName.get(name);
    if (!byHash) {
      byHash = new Map();
      tokensByName.set(name, byHash);
    }
    let token = byHash.get(padHash);
    if (!token) {
      token = byHash.size === 0 ? name : `${name}_${padHash}`;
      byHash.set(padHash, token);
      imageByToken.set(token, c);
      imageOrder.push(token);
    }
    imageTokenOf.set(c, token);
  }

  // ---- Padstacks (deduped by geometry-derived name) ----
  const padStacks = new Map<string, string[]>(); // name -> shapeForms
  const padStackNameOf = new Map<Pad, string>();
  for (const id of imageOrder) {
    const comp = imageByToken.get(id)!;
    for (const pad of comp.footprint.pads) {
      const ps = padStackFor(b, pad);
      padStackNameOf.set(pad, ps.name);
      if (!padStacks.has(ps.name)) padStacks.set(ps.name, ps.shapeForms);
    }
  }

  // ---- Via padstacks (from included net classes + any protect vias) ----
  const viaStacks = new Map<string, string[]>(); // name -> shapeForms
  const viaNameByClass = new Map<string, string>(); // netclass name -> via padstack
  for (const net of networkNets) {
    const nc = netClassOf(b, net);
    const vName = viaPadStackName(nc.viaDrill, nc.viaDiameter);
    if (!viaStacks.has(vName)) viaStacks.set(vName, viaPadStackForms(b, nc.viaDiameter));
    viaNameByClass.set(nc.name, vName);
  }

  // ---- Protect wiring (only when subsetting) ----
  const protectTracks: Track[] = nets ? b.tracks.filter((t) => opts.keep || !includeNet(t.net)) : [];
  const protectVias = nets ? b.vias.filter((v) => opts.keep || !includeNet(v.net)) : [];
  for (const v of protectVias) {
    const vName = viaPadStackName(v.drill, v.diameter);
    if (!viaStacks.has(vName)) viaStacks.set(vName, viaPadStackForms(b, v.diameter));
  }

  const dnc = defaultNetClass(b);
  // Specctra has no drill-to-drill rule, so derive via_via / via_pin copper clearances
  // that satisfy the ruleset's holeToHole given the smallest annular rings on the board.
  const holeToHole = RULESETS[b.rules]?.holeToHole ?? 0.5;
  const ring = (dia: number, drill: number): number => Math.max(0, (dia - drill) / 2);
  const minViaRing = Math.min(ring(dnc.viaDiameter, dnc.viaDrill), ...b.netClasses.map((c) => ring(c.viaDiameter, c.viaDrill)));
  let minPinRing = Infinity;
  for (const c of b.components)
    for (const p of c.footprint.pads)
      if (p.drill) minPinRing = Math.min(minPinRing, ring(Math.min(p.size.w, p.size.h), p.drill.diameter));
  // Structure-level only: freerouting silently routes nothing when a typed
  // clearance appears inside a (class ...) rule, so use the strictest value
  // (smallest rings) for the whole board.
  let drillRules = ` (clearance ${um(Math.max(dnc.clearance, holeToHole - 2 * minViaRing))} (type via_via))`;
  if (minPinRing < Infinity) drillRules += ` (clearance ${um(Math.max(dnc.clearance, holeToHole - minViaRing - minPinRing))} (type via_pin))`;
  const L = copperLayersOf(b);

  // ---- Assemble ----
  const out: string[] = [];
  out.push(`(pcb ${tok(b.name)}`);
  out.push('  (parser');
  out.push('    (string_quote ")');
  out.push('    (space_in_quoted_tokens on)');
  out.push(`    (host_cad ${HOST_CAD})`);
  out.push(`    (host_version ${HOST_VERSION})`);
  out.push('  )');
  out.push('  (resolution um 1)');
  out.push('  (unit um)');

  // structure
  out.push('  (structure');
  for (const layer of L) out.push(`    (layer ${layer} (type signal))`);
  out.push(`    (boundary ${boundaryPath(b)})`);
  // copper keepouts (router keepouts). Pour-only keepouts (keepout.pour) are
  // deliberately excluded here: they clip the pour but must not constrain the router.
  for (const k of b.keepouts) {
    if (!k.keepout.copper) continue;
    const coords = k.polygon.map((p) => `${um(p.x)} ${um(p.y)}`).join(' ');
    const kLayers = k.layers === 'all' ? L : k.layers.filter((l) => L.includes(l));
    for (const layer of kLayers) out.push(`    (keepout "" (polygon ${layer} 0 ${coords}))`);
  }
  // via keepouts
  for (const k of b.keepouts) {
    if (!k.keepout.via) continue;
    const coords = k.polygon.map((p) => `${um(p.x)} ${um(p.y)}`).join(' ');
    out.push(`    (via_keepout "" (polygon signal 0 ${coords}))`);
  }
  // Hole keepouts (mounting holes + footprint mechanical holes): freerouting
  // has no concept of a bare hole, so without this it happily routes copper
  // straight through one. Plated holes are fenced by their annulus
  // (padDiameter), NPTH by the bare drill; a slot uses its centerline capsule.
  // Grown by the default net class clearance so the router leaves normal
  // clearance around them too, same as any other keepout.
  for (const h of allHoles(b)) {
    const { start, end } = holeSlotCenterline(h);
    const r = (h.plated ? h.padDiameter : h.drill) / 2 + dnc.clearance;
    const coords = capsulePolygon(start, end, r)
      .map((p) => `${um(p.x)} ${um(p.y)}`)
      .join(' ');
    for (const layer of L) out.push(`    (keepout "" (polygon ${layer} 0 ${coords}))`);
    out.push(`    (via_keepout "" (polygon signal 0 ${coords}))`);
  }
  const allViaNames = [...viaStacks.keys()];
  if (allViaNames.length > 0) out.push(`    (via ${allViaNames.join(' ')})`);
  out.push(`    (rule (width ${um(dnc.trackWidth)}) (clearance ${um(dnc.clearance)})${drillRules})`);
  out.push('  )');

  // placement
  out.push('  (placement');
  for (const id of imageOrder) {
    out.push(`    (component ${tok(id)}`);
    for (const c of b.components) {
      if (imageTokenOf.get(c) !== id) continue;
      const side = c.side === 'bottom' ? 'back' : 'front';
      out.push(`      (place ${tok(c.refdes)} ${um(c.at.x)} ${um(c.at.y)} ${side} ${c.rotation})`);
    }
    out.push('    )');
  }
  out.push('  )');

  // library
  out.push('  (library');
  for (const id of imageOrder) {
    const comp = imageByToken.get(id)!;
    out.push(`    (image ${tok(id)}`);
    for (const pad of comp.footprint.pads) {
      const psName = padStackNameOf.get(pad)!;
      out.push(`      (pin ${psName} ${tok(pad.number)} ${um(pad.at.x)} ${um(pad.at.y)})`);
    }
    out.push('    )');
  }
  for (const [name, forms] of padStacks) {
    out.push(`    (padstack ${name} ${forms.join(' ')} (attach off))`);
  }
  for (const [name, forms] of viaStacks) {
    out.push(`    (padstack ${name} ${forms.join(' ')} (attach off))`);
  }
  out.push('  )');

  // network
  out.push('  (network');
  for (const net of networkNets) {
    const pins = net.pins.map(pinRefTok).join(' ');
    out.push(`    (net ${tok(net.name)} (pins ${pins}))`);
  }
  // classes: group included nets by their class
  const byClass = new Map<string, string[]>();
  const classOrder: string[] = [];
  for (const net of networkNets) {
    const nc = netClassOf(b, net);
    if (!byClass.has(nc.name)) {
      byClass.set(nc.name, []);
      classOrder.push(nc.name);
    }
    byClass.get(nc.name)!.push(net.name);
  }
  for (const cname of classOrder) {
    const members = byClass.get(cname)!;
    const nc = b.netClasses.find((c) => c.name === cname) ?? dnc;
    const vName = viaNameByClass.get(cname);
    const memberToks = members.map((m) => tok(m)).join(' ');
    const circuit = vName ? ` (circuit (use_via ${vName}))` : '';
    out.push(
      `    (class ${tok(cname)} ${memberToks}${circuit} (rule (width ${um(nc.trackWidth)}) (clearance ${um(nc.clearance)})))`,
    );
  }
  out.push('  )');

  // wiring (protect obstacles only when subsetting)
  if (protectTracks.length > 0 || protectVias.length > 0) {
    out.push('  (wiring');
    for (const t of protectTracks) {
      const coords = trackPoints(t)
        .map((p) => `${um(p.x)} ${um(p.y)}`)
        .join(' ');
      out.push(
        `    (wire (path ${t.layer} ${um(t.width)} ${coords}) (net ${tok(t.net)}) (type protect))`,
      );
    }
    for (const v of protectVias) {
      const vName = viaPadStackName(v.drill, v.diameter);
      out.push(`    (via ${vName} ${um(v.at.x)} ${um(v.at.y)} (net ${tok(v.net)}) (type protect))`);
    }
    out.push('  )');
  }

  out.push(')');
  out.push('');
  return out.join('\n');
}
