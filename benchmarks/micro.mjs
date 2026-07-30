// Decompose the per-pair cost into the three regimes that actually occur, so
// the numbers can be recomposed against real pair counts and hit rates rather
// than depending on my guess at their adjacency exemptions.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const buf = readFileSync(process.argv[2]);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const scene = gltf.scene;
scene.updateMatrixWorld(true);

const meshes = [];
scene.traverse(o => { if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o); });
for (const m of meshes) { m.geometry.computeBoundingBox(); m.geometry.computeBoundsTree({ strategy: SAH }); }

const _c = Array.from({ length: 8 }, () => new THREE.Vector3());
const bA = new THREE.Box3(), bB = new THREE.Box3(), mat = new THREE.Matrix4();
function aabb(mesh, t) {
  const bb = mesh.geometry.boundingBox, m = mesh.matrixWorld;
  let i = 0;
  for (let x = 0; x <= 1; x++) for (let y = 0; y <= 1; y++) for (let z = 0; z <= 1; z++)
    _c[i++].set(x ? bb.max.x : bb.min.x, y ? bb.max.y : bb.min.y,
                z ? bb.max.z : bb.min.z).applyMatrix4(m);
  t.makeEmpty();
  for (let j = 0; j < 8; j++) t.expandByPoint(_c[j]);
}

// Classify every pair once.
const reject = [], clear = [], hit = [];
for (let i = 0; i < meshes.length; i++) for (let j = i + 1; j < meshes.length; j++) {
  const a = meshes[i], b = meshes[j];
  aabb(a, bA); aabb(b, bB);
  if (!bA.intersectsBox(bB)) { reject.push([a, b]); continue; }
  mat.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
  (a.geometry.boundsTree.intersectsGeometry(b.geometry, mat) ? hit : clear).push([a, b]);
}

function time(list, label, iters) {
  if (!list.length) return console.log(`  ${label.padEnd(34)} (none in this scene)`);
  const t0 = performance.now();
  for (let k = 0; k < iters; k++)
    for (const [a, b] of list) {
      aabb(a, bA); aabb(b, bB);
      if (!bA.intersectsBox(bB)) continue;
      mat.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
      a.geometry.boundsTree.intersectsGeometry(b.geometry, mat);
    }
  const per = (performance.now() - t0) / (iters * list.length);
  console.log(`  ${label.padEnd(34)} ${list.length.toString().padStart(3)} pairs  `
            + `${(per * 1000).toFixed(1).padStart(8)} us/pair`);
}

console.log(`${process.argv[2].split('/').pop()}  (${meshes.length} meshes)`);
// warm up before timing - V8 needs the path hot
for (let k = 0; k < 30; k++) { for (const [a,b] of [...clear, ...hit]) { aabb(a,bA); aabb(b,bB); mat.copy(a.matrixWorld).invert().multiply(b.matrixWorld); a.geometry.boundsTree.intersectsGeometry(b.geometry, mat); } }
time(reject, 'AABB reject (disjoint)', 200);
time(clear,  'BVH descent, no intersection', 20);
time(hit,    'BVH descent, intersecting', 20);

const t0 = performance.now();
for (let k = 0; k < 2000; k++) scene.updateMatrixWorld(true);
console.log(`  ${'scene.updateMatrixWorld() per pose'.padEnd(34)}       `
          + `${((performance.now() - t0) / 2000 * 1000).toFixed(1)} us`);
