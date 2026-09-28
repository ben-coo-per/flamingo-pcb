/**
 * Flamingo Panel - instance transforms.
 *
 * An instance is a source board turned by a multiple of 90 degrees and
 * translated so that the bottom-left corner of its turned bounding box lands
 * on `instance.at`. Everything that maps board space to panel space goes
 * through `instanceTransform`, so the canvas, the checks, the packer and the
 * fab merge can never disagree about where a board is.
 */

import type { Point } from '@flamingo/engine';
import type { Box, Rotation, Side } from './types.js';

export interface Transform {
  rotation: Rotation;
  /** Translation applied after the rotation. */
  offset: Point;
}

/** Rotate by an exact multiple of 90 degrees without touching sin/cos. */
export function rotate90(p: Point, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: -p.y, y: p.x };
    case 180:
      return { x: -p.x, y: -p.y };
    case 270:
      return { x: p.y, y: -p.x };
  }
}

export function boxOf(pts: Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boxCorners(b: Box): Point[] {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ];
}

export function boxWidth(b: Box): number {
  return b.maxX - b.minX;
}

export function boxHeight(b: Box): number {
  return b.maxY - b.minY;
}

export function unionBox(a: Box, b: Box): Box {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** Size of a board's bounding box once turned by `rotation`. */
export function rotatedSize(bbox: Box, rotation: Rotation): { width: number; height: number } {
  const w = boxWidth(bbox);
  const h = boxHeight(bbox);
  return rotation === 90 || rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

/** Transform placing a board with bounding box `bbox` at `at`, turned by `rotation`. */
export function instanceTransform(bbox: Box, at: Point, rotation: Rotation): Transform {
  const turned = boxOf(boxCorners(bbox).map((c) => rotate90(c, rotation)));
  return { rotation, offset: { x: at.x - turned.minX, y: at.y - turned.minY } };
}

export function applyTransform(t: Transform, p: Point): Point {
  const r = rotate90(p, t.rotation);
  return { x: r.x + t.offset.x, y: r.y + t.offset.y };
}

export function applyTransformAll(t: Transform, pts: Point[]): Point[] {
  return pts.map((p) => applyTransform(t, p));
}

const SIDE_ORDER: readonly Side[] = ['E', 'N', 'W', 'S']; // CCW, 90 degrees apart

/** Which panel side a board side faces once the board is turned CCW by `rotation`. */
export function rotateSide(side: Side, rotation: Rotation): Side {
  const i = SIDE_ORDER.indexOf(side);
  return SIDE_ORDER[(i + rotation / 90) % 4]!;
}

/** Inverse of `rotateSide`: the board side that ends up facing panel side `side`. */
export function unrotateSide(side: Side, rotation: Rotation): Side {
  const i = SIDE_ORDER.indexOf(side);
  return SIDE_ORDER[(i - rotation / 90 + 4) % 4]!;
}

export function oppositeSide(side: Side): Side {
  return rotateSide(side, 180);
}

/**
 * The `at` an instance needs so that turning it to `next` keeps the centre of
 * its bounding box where it is (what a user expects from "rotate 90").
 */
export function atForRotationAboutCentre(bbox: Box, at: Point, current: Rotation, next: Rotation): Point {
  const a = rotatedSize(bbox, current);
  const b = rotatedSize(bbox, next);
  return {
    x: at.x + (a.width - b.width) / 2,
    y: at.y + (a.height - b.height) / 2,
  };
}
