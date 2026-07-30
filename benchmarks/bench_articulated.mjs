// How many pairs actually reach the BVH, per pose, on a moving machine?
//
// The survey's ~105 s per batch figure assumed all 28 AABB-overlapping pairs
// descend the BVH at every pose. That classification came from one static pose
// (the model as loaded) and ignored kinematic adjacency exemptions. Both make
// it an overestimate. This measures the real thing.
//
// Replicates the viewer faithfully:
//   - joint chain from config restPos/restQuat/parent  (js/device.js:93-115)
//   - link meshes reparented onto joint rot groups     (js/device.js:299-320)
//   - adjacency exemption                              (js/device.js:24-56)
//   - AABB broad phase then BVH narrow phase           (js/collision.js:420)

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const [glbPath, cfgPath, poseArg] = process.argv.slice(2);
const POSES = Number(poseArg ?? 2000);
const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
const buf = readFileSync(glbPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');

// ---- build the joint chain -------------------------------------------------
const root = new THREE.Group();
const restGroups = [], rotGroups = [], axes = [];
for (let i = 0; i < config.joints.length; i++) {
  const d = config.joints[i];
  const parentIdx = d.parent !== undefined ? d.parent : i - 1;
  const parentGroup = parentIdx < 0 ? root : rotGroups[parentIdx];
  const rest = new THREE.Group();
  rest.position.set(...d.restPos);
  // config stores [w,x,y,z]; three.js wants (x,y,z,w)
  rest.quaternion.set(d.restQuat[1], d.restQuat[2], d.restQuat[3], d.restQuat[0]);
  parentGroup.add(rest);
  const rot = new THREE.Group();
  rest.add(rot);
  restGroups.push(rest); rotGroups.push(rot);
  axes.push(new THREE.Vector3(...d.axis).normalize());
}

// ---- reparent link meshes onto the chain ----------------------------------
const model = gltf.scene;
model.updateMatrixWorld(true);
root.updateMatrixWorld(true);
const allNodes = {};
model.traverse(o => { if (o.name) allNodes[o.name] = o; });

const linkToJoint = Object.fromEntries(config.links.map(l => [l.name, l.joint]));
for (const [linkName, jointIdx] of Object.entries(linkToJoint)) {
  const node = allNodes[linkName];
  if (!node) { console.warn(`  link ${linkName} not in glTF`); continue; }
  node.updateWorldMatrix(true, false);
  const world = node.matrixWorld.clone();
  node.removeFromParent();
  const target = rotGroups[jointIdx];
  target.updateWorldMatrix(true, false);
  node.matrix.copy(target.matrixWorld.clone().invert().multiply(world));
  node.matrix.decompose(node.position, node.quaternion, node.scale);
  target.add(node);
}
root.updateMatrixWorld(true);

// ---- meshes, and which link each belongs to -------------------------------
const meshes = [];
root.traverse(o => { if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o); });
for (const m of meshes) { m.geometry.computeBoundingBox(); m.geometry.computeBoundsTree({ strategy: SAH }); }

function owningLink(mesh) {
  for (let n = mesh; n; n = n.parent) if (linkToJoint[n.name] !== undefined) return n.name;
  return null;
}

// ---- adjacency exemption (device.js buildAdjacencyPairs) ------------------
function movableAncestor(jointIdx) {
  let idx = config.joints[jointIdx].parent;
  while (idx >= 0) {
    if (!config.joints[idx].fixed) return idx;
    idx = config.joints[idx].parent;
  }
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
  pairs.push([meshes[i], meshes[j]]);
}
const movable = config.joints.map((j, i) => ({ j, i })).filter(x => !x.j.fixed);
console.log(`${config.name}: ${meshes.length} meshes, ${movable.length} movable joints`);
console.log(`pairs: ${meshes.length * (meshes.length - 1) / 2} total, `
  + `${pairs.length} after adjacency exemption `
  + `(${meshes.length * (meshes.length - 1) / 2 - pairs.length} exempt)`);

// ---- sweep -----------------------------------------------------------------
const _c = Array.from({ length: 8 }, () => new THREE.Vector3());
const bA = new THREE.Box3(), bB = new THREE.Box3(), mat = new THREE.Matrix4();
function aabb(mesh, t) {
  const bb = mesh.geometry.boundingBox, m = mesh.matrixWorld;
  let i = 0;
  for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++)
    _c[i++].set(x ? bb.max.x : bb.min.x, y ? bb.max.y : bb.min.y,
                z ? bb.max.z : bb.min.z).applyMatrix4(m);
  t.makeEmpty();
  for (let k = 0; k < 8; k++) t.expandByPoint(_c[k]);
}

let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

function pose() {
  for (const { j, i } of movable) {
    const [lo, hi] = j.limits ?? [-180, 180];
    rotGroups[i].setRotationFromAxisAngle(axes[i], (lo + rnd() * (hi - lo)) * Math.PI / 180);
  }
  root.updateMatrixWorld(true);
}

for (let k = 0; k < 200; k++) { pose(); for (const [a, b] of pairs) { aabb(a, bA); aabb(b, bB); } }

let survivors = 0, collisions = 0;
const hist = new Map();
const t0 = performance.now();
for (let k = 0; k < POSES; k++) {
  pose();
  let s = 0;
  for (const [a, b] of pairs) {
    aabb(a, bA); aabb(b, bB);
    if (!bA.intersectsBox(bB)) continue;
    s++;
    mat.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
    if (a.geometry.boundsTree.intersectsGeometry(b.geometry, mat)) collisions++;
  }
  survivors += s;
  hist.set(s, (hist.get(s) ?? 0) + 1);
}
const dt = performance.now() - t0;

console.log(`\n${POSES} poses in ${dt.toFixed(0)} ms -> ${(dt / POSES).toFixed(3)} ms/pose`);
console.log(`AABB survivors: ${(survivors / POSES).toFixed(2)}/pose out of ${pairs.length} pairs `
  + `(${(100 * survivors / (POSES * pairs.length)).toFixed(1)}% reach the BVH)`);
console.log(`actual collisions: ${(collisions / POSES).toFixed(2)}/pose`);
console.log('\nsurvivors per pose:');
for (const n of [...hist.keys()].sort((a, b) => a - b))
  console.log(`   ${String(n).padStart(3)} pairs: ${String(hist.get(n)).padStart(6)} poses `
    + `(${(100 * hist.get(n) / POSES).toFixed(1)}%)`);
console.log(`\n15,000-pose batch at this rate: ${(dt / POSES * 15000 / 1000).toFixed(1)} s`);
