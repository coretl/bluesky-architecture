// The two-tier architecture as actually proposed, measured end to end.
//
// Earlier benchmarks timed AABB+BVH on every pair at every pose and concluded
// the fine tier "does not fit". That measured the fine tier as the primary
// path, which is not the design. In the design:
//
//   coarse: conservative spheres on every point, reporting WHICH pair is
//           implicated, not just a boolean
//   fine:   exact triangle BVH, on only the (pose, pair) combinations the
//           coarse tier flagged
//
// The cost of the fine tier is therefore flag-rate driven, not pair-count
// driven. This measures both tiers and the flag rate that connects them.
//
// Sphere decomposition is a conservative 2x2x2 octant cover of each mesh's
// local AABB: each sphere covers one octant, so the union covers the AABB,
// which covers the mesh. Crude but provably conservative, which is what the
// coarse tier requires.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const [glbPath, cfgPath, poseArg, padArg] = process.argv.slice(2);
const POSES = Number(poseArg ?? 2000);
const PAD = Number(padArg ?? 0.005); // metres of coarse padding

const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
const buf = readFileSync(glbPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

// ---- articulate (same as bench_articulated.mjs) ---------------------------
const root = new THREE.Group();
const rotGroups = [], axes = [];
for (let i = 0; i < config.joints.length; i++) {
  const d = config.joints[i];
  const pIdx = d.parent !== undefined ? d.parent : i - 1;
  const rest = new THREE.Group();
  rest.position.set(...d.restPos);
  rest.quaternion.set(d.restQuat[1], d.restQuat[2], d.restQuat[3], d.restQuat[0]);
  (pIdx < 0 ? root : rotGroups[pIdx]).add(rest);
  const rot = new THREE.Group();
  rest.add(rot);
  rotGroups.push(rot);
  axes.push(new THREE.Vector3(...d.axis).normalize());
}

const model = gltf.scene;
model.updateMatrixWorld(true);
root.updateMatrixWorld(true);
const allNodes = {};
model.traverse(o => { if (o.name) allNodes[o.name] = o; });
const linkToJoint = Object.fromEntries(config.links.map(l => [l.name, l.joint]));
const reparented = new Set();
for (const [linkName, jointIdx] of Object.entries(linkToJoint)) {
  const node = allNodes[linkName];
  if (!node) continue;
  node.updateWorldMatrix(true, false);
  const world = node.matrixWorld.clone();
  node.removeFromParent();
  const target = rotGroups[jointIdx];
  target.updateWorldMatrix(true, false);
  node.matrix.copy(target.matrixWorld.clone().invert().multiply(world));
  node.matrix.decompose(node.position, node.quaternion, node.scale);
  target.add(node);
  node.traverse(c => { if (c.name) reparented.add(c.name); });
}
// statics the viewer keeps as world obstacles - the base, sample markers
const statics = [];
model.traverse(c => {
  if (c.isMesh && !reparented.has(c.name) && c.geometry?.getAttribute('position'))
    statics.push(c);
});
for (const m of statics) {
  m.updateWorldMatrix(true, false);
  const wm = m.matrixWorld.clone();
  m.removeFromParent();
  m.matrix.copy(wm);
  m.matrix.decompose(m.position, m.quaternion, m.scale);
  root.add(m);
}
root.updateMatrixWorld(true);

const meshes = [];
root.traverse(o => { if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o); });
for (const m of meshes) { m.geometry.computeBoundingBox(); m.geometry.computeBoundsTree({ strategy: SAH }); }

function owningLink(mesh) {
  for (let n = mesh; n; n = n.parent) if (linkToJoint[n.name] !== undefined) return n.name;
  return null;
}
function movableAncestor(jointIdx) {
  let idx = config.joints[jointIdx].parent;
  while (idx >= 0) { if (!config.joints[idx].fixed) return idx; idx = config.joints[idx].parent; }
  return -1;
}
const adj = new Set();
for (const a of config.links) for (const b of config.links) {
  if (a.name >= b.name) continue;
  const jA = config.joints[a.joint].fixed ? movableAncestor(a.joint) : a.joint;
  const jB = config.joints[b.joint].fixed ? movableAncestor(b.joint) : b.joint;
  if (jA === jB || jA === movableAncestor(b.joint) || jB === movableAncestor(a.joint))
    adj.add([a.name, b.name].sort().join('|'));
}
const pairs = [];
for (let i = 0; i < meshes.length; i++) for (let j = i + 1; j < meshes.length; j++) {
  const la = owningLink(meshes[i]), lb = owningLink(meshes[j]);
  if (la && lb && (la === lb || adj.has([la, lb].sort().join('|')))) continue;
  pairs.push([i, j]);
}

// ---- conservative sphere cover fitted to the geometry ---------------------
// Lloyd-relaxed clustering of triangle centroids, then each sphere is grown to
// contain every vertex of every triangle assigned to it. A triangle lies in the
// convex hull of its vertices, so covering the vertices covers the triangle,
// so the union of spheres covers the mesh. Conservative by construction, and
// far tighter than wrapping the AABB.
const K = Number(process.env.K ?? 8);

function fitSpheres(geom, k) {
  const pos = geom.getAttribute('position');
  const idx = geom.index;
  const nTri = idx ? idx.count / 3 : pos.count / 3;
  const cent = new Float64Array(nTri * 3);
  const vi = new Int32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    for (let c = 0; c < 3; c++) vi[t * 3 + c] = idx ? idx.getX(t * 3 + c) : t * 3 + c;
    for (let d = 0; d < 3; d++) {
      const f = d === 0 ? 'getX' : d === 1 ? 'getY' : 'getZ';
      cent[t * 3 + d] = (pos[f](vi[t * 3]) + pos[f](vi[t * 3 + 1]) + pos[f](vi[t * 3 + 2])) / 3;
    }
  }
  // init: spread seeds along the longest axis of the centroid cloud
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < nTri; t++) for (let d = 0; d < 3; d++) {
    lo[d] = Math.min(lo[d], cent[t * 3 + d]); hi[d] = Math.max(hi[d], cent[t * 3 + d]);
  }
  const seeds = [];
  for (let s = 0; s < k; s++) {
    const f = k === 1 ? 0.5 : s / (k - 1);
    seeds.push([lo[0] + f * (hi[0] - lo[0]), lo[1] + f * (hi[1] - lo[1]), lo[2] + f * (hi[2] - lo[2])]);
  }
  const assign = new Int32Array(nTri);
  for (let iter = 0; iter < 12; iter++) {
    for (let t = 0; t < nTri; t++) {
      let best = 0, bd = Infinity;
      for (let s = 0; s < k; s++) {
        const dx = cent[t*3]-seeds[s][0], dy = cent[t*3+1]-seeds[s][1], dz = cent[t*3+2]-seeds[s][2];
        const d2 = dx*dx + dy*dy + dz*dz;
        if (d2 < bd) { bd = d2; best = s; }
      }
      assign[t] = best;
    }
    const sum = seeds.map(() => [0, 0, 0, 0]);
    for (let t = 0; t < nTri; t++) {
      const s = sum[assign[t]];
      s[0] += cent[t*3]; s[1] += cent[t*3+1]; s[2] += cent[t*3+2]; s[3]++;
    }
    for (let s = 0; s < k; s++) if (sum[s][3])
      seeds[s] = [sum[s][0]/sum[s][3], sum[s][1]/sum[s][3], sum[s][2]/sum[s][3]];
  }
  // grow each sphere to contain every vertex of its triangles
  const rad = new Float64Array(k);
  for (let t = 0; t < nTri; t++) {
    const s = assign[t];
    for (let c = 0; c < 3; c++) {
      const v = vi[t * 3 + c];
      const dx = pos.getX(v)-seeds[s][0], dy = pos.getY(v)-seeds[s][1], dz = pos.getZ(v)-seeds[s][2];
      rad[s] = Math.max(rad[s], Math.sqrt(dx*dx + dy*dy + dz*dz));
    }
  }
  const out = [];
  for (let s = 0; s < k; s++) if (rad[s] > 0)
    out.push({ local: new THREE.Vector3(...seeds[s]), r: rad[s] + PAD });
  return out;
}

const spheres = meshes.map(m => fitSpheres(m.geometry, K));
const nSpheres = spheres.reduce((s, a) => s + a.length, 0);

const movable = config.joints.map((j, i) => ({ j, i })).filter(x => !x.j.fixed);
console.log(`${config.name}: ${meshes.length} meshes (${statics.length} static), `
  + `${movable.length} joints, ${pairs.length} pairs after exemption`);
console.log(`coarse model: ${nSpheres} spheres (K=${K}/mesh, fitted, pad ${PAD * 1000} mm)`);

// ---- pose driver -----------------------------------------------------------
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
// Random joint configurations of a densely packed diffractometer are almost
// always in collision (~12 real collisions/pose measured), so they are not a
// scan. Perturb around the config's demoPose instead - a known-valid pose -
// by DELTA degrees, which is what a trajectory through a valid region does.
const DELTA = Number(process.env.DELTA ?? 5);
const demo = config.demoPose ?? config.joints.map(() => 0);
function pose() {
  for (const { j, i } of movable) {
    const [lo, hi] = j.limits ?? [-180, 180];
    const base = demo[i] ?? 0;
    const deg = Math.min(hi, Math.max(lo, base + (rnd() * 2 - 1) * DELTA));
    rotGroups[i].setRotationFromAxisAngle(axes[i], deg * Math.PI / 180);
  }
  root.updateMatrixWorld(true);
}

const world = meshes.map(() => []);
function placeSpheres() {
  for (let m = 0; m < meshes.length; m++) {
    const mat = meshes[m].matrixWorld;
    const src = spheres[m];
    const dst = world[m];
    for (let k = 0; k < src.length; k++) {
      dst[k] = dst[k] ?? { p: new THREE.Vector3(), r: 0 };
      dst[k].p.copy(src[k].local).applyMatrix4(mat);
      dst[k].r = src[k].r;
    }
  }
}
function coarseFlags(out) {
  out.length = 0;
  for (const [i, j] of pairs) {
    const A = world[i], B = world[j];
    let hit = false;
    for (let a = 0; a < A.length && !hit; a++)
      for (let b = 0; b < B.length; b++) {
        const t = A[a].r + B[b].r;
        if (A[a].p.distanceToSquared(B[b].p) < t * t) { hit = true; break; }
      }
    if (hit) out.push([i, j]);
  }
}

const _c = Array.from({ length: 8 }, () => new THREE.Vector3());
const bA = new THREE.Box3(), bB = new THREE.Box3(), mat4 = new THREE.Matrix4();
function aabb(mesh, t) {
  const bb = mesh.geometry.boundingBox, m = mesh.matrixWorld;
  let i = 0;
  for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++)
    _c[i++].set(x ? bb.max.x : bb.min.x, y ? bb.max.y : bb.min.y,
                z ? bb.max.z : bb.min.z).applyMatrix4(m);
  t.makeEmpty();
  for (let k = 0; k < 8; k++) t.expandByPoint(_c[k]);
}
function fine(i, j) {
  const a = meshes[i], b = meshes[j];
  aabb(a, bA); aabb(b, bB);
  if (!bA.intersectsBox(bB)) return false;
  mat4.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
  return a.geometry.boundsTree.intersectsGeometry(b.geometry, mat4);
}

const flagged = [];
for (let k = 0; k < 100; k++) { pose(); placeSpheres(); coarseFlags(flagged); }

// ---- tier 1: coarse over the whole batch ----------------------------------
let tCoarse = 0, nFlagged = 0, nPosesFlagged = 0;
const flagPerPose = [];
let t0 = performance.now();
for (let k = 0; k < POSES; k++) {
  pose();
  placeSpheres();
  coarseFlags(flagged);
  nFlagged += flagged.length;
  if (flagged.length) nPosesFlagged++;
  flagPerPose.push(flagged.length);
}
tCoarse = performance.now() - t0;

// ---- tier 2: fine, only on what tier 1 flagged ----------------------------
seed = 12345;
for (let k = 0; k < 100; k++) { pose(); placeSpheres(); coarseFlags(flagged); }
seed = 12345;
let tFine = 0, nReal = 0, nFineCalls = 0;
t0 = performance.now();
for (let k = 0; k < POSES; k++) {
  pose();
  placeSpheres();
  coarseFlags(flagged);
  for (const [i, j] of flagged) { nFineCalls++; if (fine(i, j)) nReal++; }
}
const tBoth = performance.now() - t0;
tFine = tBoth - tCoarse;

const pct = 100 * nFlagged / (POSES * pairs.length);
console.log(`\n--- tier 1: coarse spheres, every pose ---`);
console.log(`  ${tCoarse.toFixed(0)} ms / ${POSES} poses = ${(tCoarse / POSES).toFixed(3)} ms/pose`);
console.log(`  flagged ${(nFlagged / POSES).toFixed(2)} pairs/pose `
  + `(${pct.toFixed(1)}% of ${pairs.length} pairs); `
  + `${(100 * nPosesFlagged / POSES).toFixed(1)}% of poses flagged something`);
console.log(`\n--- tier 2: fine BVH, only on flagged pairs ---`);
console.log(`  ${nFineCalls} calls over ${POSES} poses = ${(nFineCalls / POSES).toFixed(2)}/pose`);
console.log(`  ${tFine.toFixed(0)} ms total = ${(tFine / Math.max(1, nFineCalls) * 1000).toFixed(0)} us/call`);
console.log(`  ${nReal} real collisions confirmed `
  + `(coarse false-positive rate ${(100 * (nFineCalls - nReal) / Math.max(1, nFineCalls)).toFixed(1)}%)`);
console.log(`\n--- combined ---`);
console.log(`  ${(tBoth / POSES).toFixed(3)} ms/pose  ->  15,000-pose batch = ${(tBoth / POSES * 15000 / 1000).toFixed(2)} s`);
console.log(`  for comparison, fine-on-every-pair would be `
  + `${pairs.length} pairs x ${POSES} poses = ${pairs.length * POSES} BVH calls`);
