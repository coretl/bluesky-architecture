// A BVH over TIME as well as space.
//
// Take positions at 256 Hz, build a binary tree over the time axis: leaves are
// per-interval swept boxes, each internal node is the union of its children,
// up to one box covering the whole second. Check the root first; descend only
// where it overlaps.
//
// Why this is sound: soundness only has to hold at the leaves. Every internal
// node is a union of its children's boxes, so it contains everything they
// contain. Pay the arc correction once at 1/256 s - a couple of mm - and
// conservatism propagates upward for free.
//
// Why it should pay: during a real scan most body pairs are nowhere near each
// other for the entire second, so they cost ONE box test instead of 256.
//
// This needs a real trajectory. Random perturbation of joint angles is noise,
// not motion, and a temporal tree over noise has huge boxes at every level.
// So the trajectory here is a scan: a couple of axes sweeping smoothly while
// the rest hold, which is what a diffractometer actually does.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const [glbPath, cfgPath] = process.argv.slice(2);
const RATE = Number(process.env.RATE ?? 256);
const SECONDS = Number(process.env.SECONDS ?? 8);
const WMAX = Number(process.env.WMAX ?? 1.6);

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
for (const child of [...model.children]) {
  const keep = [];
  child.traverse(c => { if (c.isMesh && !reparented.has(c.name)) keep.push(c); });
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
for (const m of meshes) m.geometry.computeBoundingBox();

function owningJoint(mesh) {
  for (let n = mesh; n; n = n.parent) {
    if (linkToJoint[n.name] !== undefined) return linkToJoint[n.name];
  }
  return -1;
}
function owningLink(mesh) {
  for (let n = mesh; n; n = n.parent) if (linkToJoint[n.name] !== undefined) return n.name;
  return null;
}
function movableAncestor(j) {
  let i = config.joints[j].parent;
  while (i >= 0) { if (!config.joints[i].fixed) return i; i = config.joints[i].parent; }
  return -1;
}
function ancestors(j) {
  const out = [];
  for (let i = j; i >= 0; i = config.joints[i].parent ?? -1) {
    if (!config.joints[i].fixed) out.push(i);
    if (config.joints[i].parent === undefined) break;
  }
  return out;
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
const bodyAnc = meshes.map(m => ancestors(owningJoint(m)));

// ---- a scan trajectory, not noise -----------------------------------------
// Two axes sweep smoothly, the rest hold at demoPose. That is a scan.
const movable = config.joints.map((j, i) => ({ j, i })).filter(x => !x.j.fixed);
const demo = config.demoPose ?? config.joints.map(() => 0);
const sweeping = movable.slice(0, 2).map(x => x.i);
const N = RATE * SECONDS;
const dt = 1 / RATE;

function setPose(k) {
  const t = k * dt;
  for (const { j, i } of movable) {
    const [lo, hi] = j.limits ?? [-180, 180];
    let deg = demo[i] ?? 0;
    if (sweeping.includes(i)) {
      const w = WMAX * (i === sweeping[0] ? 1 : 0.4); // rad/s
      deg += w * t * 180 / Math.PI * (i === sweeping[0] ? 1 : -1);
    }
    // wrap into limits so a long sweep stays legal
    const span = hi - lo;
    deg = lo + ((((deg - lo) % span) + span) % span);
    rotGroups[i].setRotationFromAxisAngle(axes[i], deg * Math.PI / 180);
  }
  root.updateMatrixWorld(true);
}
function omegaOf(i) {
  if (!sweeping.includes(i)) return 0;
  return WMAX * (i === sweeping[0] ? 1 : 0.4);
}

// ---- per-sample world AABBs, plus the leaf motion bound -------------------
const _p = new THREE.Vector3();
const sampLo = meshes.map(() => new Float64Array(N * 3));
const sampHi = meshes.map(() => new Float64Array(N * 3));
// conservative per-body inflation for one leaf interval: L/2 using the body's
// farthest point from each ancestor axis
const inflate = new Float64Array(meshes.length);

const tBuild0 = performance.now();
for (let k = 0; k < N; k++) {
  setPose(k);
  for (let m = 0; m < meshes.length; m++) {
    const bb = meshes[m].geometry.boundingBox, mat = meshes[m].matrixWorld;
    let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
    for (let c = 0; c < 8; c++) {
      _p.set(c&1?bb.max.x:bb.min.x, c&2?bb.max.y:bb.min.y, c&4?bb.max.z:bb.min.z)
        .applyMatrix4(mat);
      if(_p.x<x0)x0=_p.x; if(_p.x>x1)x1=_p.x;
      if(_p.y<y0)y0=_p.y; if(_p.y>y1)y1=_p.y;
      if(_p.z<z0)z0=_p.z; if(_p.z>z1)z1=_p.z;
    }
    sampLo[m].set([x0,y0,z0], k*3);
    sampHi[m].set([x1,y1,z1], k*3);
  }
}
// inflation: farthest corner of the body from each moving ancestor axis
setPose(0);
for (let m = 0; m < meshes.length; m++) {
  const bb = meshes[m].geometry.boundingBox, mat = meshes[m].matrixWorld;
  let sum = 0;
  for (const j of bodyAnc[m]) {
    const w = omegaOf(j);
    if (!w) continue;
    const o = new THREE.Vector3().setFromMatrixPosition(rotGroups[j].matrixWorld);
    const ax = axes[j].clone().transformDirection(rotGroups[j].matrixWorld).normalize();
    let dmax = 0;
    for (let c = 0; c < 8; c++) {
      _p.set(c&1?bb.max.x:bb.min.x, c&2?bb.max.y:bb.min.y, c&4?bb.max.z:bb.min.z)
        .applyMatrix4(mat).sub(o);
      dmax = Math.max(dmax, _p.clone().sub(ax.clone().multiplyScalar(_p.dot(ax))).length());
    }
    sum += dmax * Math.abs(w * dt);
  }
  inflate[m] = sum / 2;
}

// ---- temporal tree per body -----------------------------------------------
// level 0 leaves: interval [k, k+1] = union of two samples, inflated.
// level L: union of two level L-1 nodes. Conservative by construction.
const levels = [];
{
  const nLeaf = N - 1;
  const lo = meshes.map(() => new Float64Array(nLeaf * 3));
  const hi = meshes.map(() => new Float64Array(nLeaf * 3));
  for (let m = 0; m < meshes.length; m++) {
    const inf = inflate[m];
    for (let k = 0; k < nLeaf; k++) for (let d = 0; d < 3; d++) {
      lo[m][k*3+d] = Math.min(sampLo[m][k*3+d], sampLo[m][(k+1)*3+d]) - inf;
      hi[m][k*3+d] = Math.max(sampHi[m][k*3+d], sampHi[m][(k+1)*3+d]) + inf;
    }
  }
  levels.push({ lo, hi, count: nLeaf });
  while (levels[levels.length-1].count > 1) {
    const prev = levels[levels.length-1];
    const cnt = Math.ceil(prev.count / 2);
    const l = meshes.map(() => new Float64Array(cnt*3));
    const h = meshes.map(() => new Float64Array(cnt*3));
    for (let m = 0; m < meshes.length; m++) for (let k = 0; k < cnt; k++) {
      const a = 2*k, b = Math.min(2*k+1, prev.count-1);
      for (let d = 0; d < 3; d++) {
        l[m][k*3+d] = Math.min(prev.lo[m][a*3+d], prev.lo[m][b*3+d]);
        h[m][k*3+d] = Math.max(prev.hi[m][a*3+d], prev.hi[m][b*3+d]);
      }
    }
    levels.push({ lo: l, hi: h, count: cnt });
  }
}
const tBuild = performance.now() - tBuild0;

function boxOverlap(L, ma, mb, k) {
  const lv = levels[L];
  const al = lv.lo[ma], ah = lv.hi[ma], bl = lv.lo[mb], bh = lv.hi[mb];
  const i = k*3;
  return !(ah[i]<bl[i] || bh[i]<al[i] || ah[i+1]<bl[i+1] ||
           bh[i+1]<al[i+1] || ah[i+2]<bl[i+2] || bh[i+2]<al[i+2]);
}

console.log(`${config.name}: ${meshes.length} bodies, ${pairs.length} pairs`);
console.log(`trajectory: ${SECONDS}s at ${RATE} Hz = ${N} samples, `
  + `${sweeping.length} axes sweeping at <=${WMAX} rad/s`);
console.log(`temporal tree: ${levels.length} levels, root spans `
  + `${(N/ (1<<(levels.length-1))).toFixed(0)}..${N} samples`);
console.log(`leaf inflation: ${(Math.max(...inflate)*1000).toFixed(2)} mm max`);
console.log(`build: ${tBuild.toFixed(0)} ms\n`);

// ---- flat: every pair at every interval -----------------------------------
let flatTests = 0, flatFlagged = 0;
let t0 = performance.now();
for (const [ma, mb] of pairs) {
  for (let k = 0; k < levels[0].count; k++) {
    flatTests++;
    if (boxOverlap(0, ma, mb, k)) flatFlagged++;
  }
}
const tFlat = performance.now() - t0;

// ---- temporal descent ------------------------------------------------------
// flat Int32 stack: pushing [L,k] arrays allocates two objects per node and
// measures the allocator rather than the traversal
const stack = new Int32Array(4096);
function descend(ma, mb) {
  let sp = 0, tests = 0, flags = 0;
  stack[sp++] = levels.length - 1; stack[sp++] = 0;
  while (sp) {
    const k = stack[--sp], L = stack[--sp];
    if (k >= levels[L].count) continue;
    tests++;
    if (!boxOverlap(L, ma, mb, k)) continue;
    if (L === 0) { flags++; continue; }
    stack[sp++] = L - 1; stack[sp++] = 2 * k;
    stack[sp++] = L - 1; stack[sp++] = 2 * k + 1;
  }
  return [tests, flags];
}

// classify pairs: does this pair ever come near, anywhere in the window?
const everFlags = pairs.map(([ma, mb]) => {
  for (let k = 0; k < levels[0].count; k++) if (boxOverlap(0, ma, mb, k)) return true;
  return false;
});
const nClean = everFlags.filter(x => !x).length;

let treeTests = 0, treeFlagged = 0, cleanTests = 0, dirtyTests = 0;
t0 = performance.now();
for (let i = 0; i < pairs.length; i++) {
  const [tests, flags] = descend(pairs[i][0], pairs[i][1]);
  treeTests += tests; treeFlagged += flags;
  if (everFlags[i]) dirtyTests += tests; else cleanTests += tests;
}
const tTree = performance.now() - t0;

console.log(`${'method'.padEnd(22)} ${'box tests'.padStart(12)} ${'flagged'.padStart(10)} ${'ms'.padStart(8)}`);
console.log(`${'flat (every step)'.padEnd(22)} ${flatTests.toLocaleString().padStart(12)} `
  + `${flatFlagged.toLocaleString().padStart(10)} ${tFlat.toFixed(1).padStart(8)}`);
console.log(`${'temporal tree'.padEnd(22)} ${treeTests.toLocaleString().padStart(12)} `
  + `${treeFlagged.toLocaleString().padStart(10)} ${tTree.toFixed(1).padStart(8)}`);
console.log(`\nsame answer: ${flatFlagged === treeFlagged ? 'YES' : 'NO - BUG'}`);
console.log(`overall: ${(flatTests/treeTests).toFixed(1)}x fewer tests, `
  + `${(tFlat/tTree).toFixed(1)}x wall clock\n`);

console.log(`split by whether the pair ever comes near, over ${SECONDS}s:`);
const perClean = nClean ? cleanTests / nClean : 0;
const perDirty = (pairs.length - nClean) ? dirtyTests / (pairs.length - nClean) : 0;
console.log(`  ${nClean} pairs never near   : ${perClean.toFixed(1)} tests each `
  + `(flat would be ${levels[0].count}) -> ${(levels[0].count/Math.max(perClean,1e-9)).toFixed(0)}x`);
console.log(`  ${pairs.length - nClean} pairs come near     : ${perDirty.toFixed(0)} tests each `
  + `(flat would be ${levels[0].count}) -> ${(levels[0].count/Math.max(perDirty,1e-9)).toFixed(2)}x`);
console.log(`\n${(100*flatFlagged/flatTests).toFixed(1)}% of intervals flagged overall - `
  + `a temporal tree only pays when flags are sparse`);
