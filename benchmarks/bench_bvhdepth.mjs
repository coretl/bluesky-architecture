// Rejection rate vs BVH depth.
//
// The coarse tier does not have to be a hand-authored capsule model. A mesh's
// BVH is already a fitted hierarchy of bounding volumes, built automatically,
// conservative by construction, and impossible to drift out of sync with the
// mesh because it IS the mesh's own structure.
//
// So the coarse tier becomes a depth knob: descend both trees together, and if
// the boxes still overlap when you hit the depth limit, flag the pair for the
// exact check. Depth 0 is exactly what the prototype does today (one box per
// mesh). This measures what deeper costs and buys.
//
// Reported per depth: what fraction of pairs are rejected, what fraction are
// flagged, how many are really colliding (exact triangle check as ground
// truth), and the resulting false-positive rate.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const [glbPath, cfgPath] = process.argv.slice(2);
const POSES = Number(process.env.POSES ?? 200);
const DELTA = Number(process.env.DELTA ?? 15);
const MAXD = Number(process.env.MAXD ?? 6);

const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
const buf = readFileSync(glbPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

// ---- articulate ------------------------------------------------------------
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
for (const m of [...model.children]) {
  const keep = [];
  m.traverse(c => { if (c.isMesh && !reparented.has(c.name)) keep.push(c); });
  for (const c of keep) {
    c.updateWorldMatrix(true, false);
    const wm = c.matrixWorld.clone();
    c.removeFromParent();
    c.matrix.copy(wm);
    c.matrix.decompose(c.position, c.quaternion, c.scale);
    root.add(c);
  }
}
root.updateMatrixWorld(true);

const meshes = [];
root.traverse(o => { if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o); });
for (const m of meshes) { m.geometry.computeBoundingBox(); m.geometry.computeBoundsTree({ strategy: SAH }); }

function owningLink(mesh) {
  for (let n = mesh; n; n = n.parent) if (linkToJoint[n.name] !== undefined) return n.name;
  return null;
}
function movableAncestor(j) {
  let i = config.joints[j].parent;
  while (i >= 0) { if (!config.joints[i].fixed) return i; i = config.joints[i].parent; }
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

// ---- pull each BVH out as an explicit tree --------------------------------
// traverse() is a DFS handing back (depth, isLeaf, boundingData, ...), so the
// parent of a node at depth d is the most recent node seen at depth d-1.
function extractTree(bvh) {
  const nodes = [];
  const stack = [];
  bvh.traverse((depth, isLeaf, bounds) => {
    const idx = nodes.length;
    nodes.push({
      lo: [bounds[0], bounds[1], bounds[2]],
      hi: [bounds[3], bounds[4], bounds[5]],
      isLeaf, depth, kids: [],
    });
    if (depth > 0) nodes[stack[depth - 1]].kids.push(idx);
    stack[depth] = idx;
  });
  return nodes;
}
const trees = meshes.map(m => extractTree(m.geometry.boundsTree));
const maxDepth = Math.max(...trees.map(t => Math.max(...t.map(n => n.depth))));
console.log(`${config.name}: ${meshes.length} meshes, ${pairs.length} pairs, `
  + `BVH depth up to ${maxDepth}`);
console.log(`nodes per mesh: ${trees.map(t => t.length).join(', ')}`);

// ---- per-pose world AABBs for every node up to MAXD -----------------------
const worldLo = trees.map(t => t.map(() => new Float64Array(3)));
const worldHi = trees.map(t => t.map(() => new Float64Array(3)));
const need = trees.map(t => t.map(n => n.depth <= MAXD));

const _p = new THREE.Vector3();
function refreshWorld() {
  for (let m = 0; m < meshes.length; m++) {
    const mat = meshes[m].matrixWorld, t = trees[m];
    for (let i = 0; i < t.length; i++) {
      if (!need[m][i]) continue;
      const n = t[i], lo = worldLo[m][i], hi = worldHi[m][i];
      lo[0] = lo[1] = lo[2] = Infinity;
      hi[0] = hi[1] = hi[2] = -Infinity;
      for (let c = 0; c < 8; c++) {
        _p.set(c & 1 ? n.hi[0] : n.lo[0], c & 2 ? n.hi[1] : n.lo[1], c & 4 ? n.hi[2] : n.lo[2]);
        _p.applyMatrix4(mat);
        if (_p.x < lo[0]) lo[0] = _p.x; if (_p.x > hi[0]) hi[0] = _p.x;
        if (_p.y < lo[1]) lo[1] = _p.y; if (_p.y > hi[1]) hi[1] = _p.y;
        if (_p.z < lo[2]) lo[2] = _p.z; if (_p.z > hi[2]) hi[2] = _p.z;
      }
    }
  }
}
function overlap(ma, ia, mb, ib) {
  const al = worldLo[ma][ia], ah = worldHi[ma][ia];
  const bl = worldLo[mb][ib], bh = worldHi[mb][ib];
  return !(ah[0] < bl[0] || bh[0] < al[0] || ah[1] < bl[1] ||
           bh[1] < al[1] || ah[2] < bl[2] || bh[2] < al[2]);
}
// depth-limited dual descent: true = still overlapping at the limit
function flagged(ma, mb, limit) {
  const ta = trees[ma], tb = trees[mb];
  const stack = [[0, 0]];
  while (stack.length) {
    const [ia, ib] = stack.pop();
    if (!overlap(ma, ia, mb, ib)) continue;
    const na = ta[ia], nb = tb[ib];
    if (na.depth >= limit || nb.depth >= limit || (na.isLeaf && nb.isLeaf)) return true;
    if (na.isLeaf) { for (const k of nb.kids) stack.push([ia, k]); }
    else if (nb.isLeaf) { for (const k of na.kids) stack.push([k, ib]); }
    else if ((na.hi[0]-na.lo[0]) > (nb.hi[0]-nb.lo[0])) {
      for (const k of na.kids) stack.push([k, ib]);
    } else { for (const k of nb.kids) stack.push([ia, k]); }
  }
  return false;
}

// ---- poses -----------------------------------------------------------------
let seed = 99;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const demo = config.demoPose ?? config.joints.map(() => 0);
const movable = config.joints.map((j, i) => ({ j, i })).filter(x => !x.j.fixed);
function pose() {
  for (const { j, i } of movable) {
    const [lo, hi] = j.limits ?? [-180, 180];
    const deg = Math.min(hi, Math.max(lo, (demo[i] ?? 0) + (rnd() * 2 - 1) * DELTA));
    rotGroups[i].setRotationFromAxisAngle(axes[i], deg * Math.PI / 180);
  }
  root.updateMatrixWorld(true);
}

// ---- ground truth ----------------------------------------------------------
const mat4 = new THREE.Matrix4();
function exact(ia, ib) {
  const a = meshes[ia], b = meshes[ib];
  mat4.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
  return a.geometry.boundsTree.intersectsGeometry(b.geometry, mat4);
}

seed = 99;
const truth = [];
for (let k = 0; k < POSES; k++) {
  pose();
  const row = [];
  for (const [ia, ib] of pairs) row.push(exact(ia, ib));
  truth.push(row);
}
const totalReal = truth.reduce((s, r) => s + r.filter(Boolean).length, 0);
console.log(`ground truth: ${(totalReal / POSES).toFixed(2)} real collisions/pose\n`);

console.log(`${'depth'.padStart(6)} ${'nodes/mesh'.padStart(11)} ${'rejected'.padStart(10)} `
  + `${'flagged'.padStart(9)} ${'false pos'.padStart(10)} ${'ms/pose'.padStart(9)}`);

for (let d = 0; d <= MAXD; d++) {
  seed = 99;
  let flag = 0, miss = 0;
  const t0 = performance.now();
  for (let k = 0; k < POSES; k++) {
    pose();
    refreshWorld();
    for (let p = 0; p < pairs.length; p++) {
      const f = flagged(pairs[p][0], pairs[p][1], d);
      if (f) flag++;
      else if (truth[k][p]) miss++;
    }
  }
  const dt = (performance.now() - t0) / POSES;
  const nPerMesh = (trees.reduce((s, t) => s + t.filter(n => n.depth <= d).length, 0) / trees.length);
  const rejected = 100 * (1 - flag / (POSES * pairs.length));
  const fp = flag ? 100 * (flag - totalReal) / flag : 0;
  console.log(`${String(d).padStart(6)} ${nPerMesh.toFixed(1).padStart(11)} `
    + `${rejected.toFixed(1).padStart(9)}% ${(flag / POSES).toFixed(1).padStart(9)} `
    + `${fp.toFixed(1).padStart(9)}% ${dt.toFixed(3).padStart(9)}`
    + (miss ? `   MISSED ${miss}` : ''));
}
