// Ray casting as the fine pass: what does it cost, and what does it miss?
//
// Gareth describes the intended design as capsules first, ray casting second.
// Ray casting against a BVH is fast, but it *samples* - it can only find what
// a ray happens to hit. This measures both the speed and the miss rate as a
// function of ray count, on the real i16 geometry.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const buf = readFileSync(process.argv[2]);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const scene = gltf.scene;
scene.updateMatrixWorld(true);

const meshes = [];
scene.traverse(o => { if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o); });
for (const m of meshes) m.geometry.computeBoundsTree();
console.log(`${meshes.length} meshes, `
  + `${meshes.reduce((s, m) => s + (m.geometry.index?.count ?? 0) / 3, 0).toLocaleString()} triangles`);

// --- raw ray throughput ----------------------------------------------------
const rc = new THREE.Raycaster();
rc.firstHitOnly = true;
const target = meshes.reduce((a, b) =>
  (a.geometry.index?.count ?? 0) > (b.geometry.index?.count ?? 0) ? a : b);
const box = new THREE.Box3().setFromObject(target);
const c = box.getCenter(new THREE.Vector3());
const r = box.getSize(new THREE.Vector3()).length() / 2;

// Reuse every object and hit the BVH directly - allocating a Vector3 and a
// results array per ray would measure the allocator, not the ray tracer.
const N = 200000;
const dir = new THREE.Vector3();
const origin = new THREE.Vector3();
const bvh = target.geometry.boundsTree;
const inv = new THREE.Matrix4().copy(target.matrixWorld).invert();
const localRay = new THREE.Ray();

const t0 = performance.now();
let hits = 0;
for (let i = 0; i < N; i++) {
  const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
  dir.set(Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph));
  origin.copy(c).addScaledVector(dir, -r * 1.5);
  localRay.set(origin, dir).applyMatrix4(inv);
  if (bvh.raycastFirst(localRay, THREE.FrontSide)) hits++;
}
const per = (performance.now() - t0) / N;
console.log(`\nray throughput vs largest mesh: ${(per * 1000).toFixed(2)} us/ray `
  + `(${hits} of ${N} hit, objects reused, BVH called directly)`);

// --- what a fine pass would cost -------------------------------------------
console.log('\ncost of a raycast fine pass, per flagged pose:');
console.log(`   ${'rays/pose'.padStart(10)} ${'time/pose'.padStart(12)} `
  + `${'poses in 500ms'.padStart(16)}`);
for (const rays of [64, 256, 1024, 4096, 16384]) {
  const t = per * rays;
  console.log(`   ${String(rays).padStart(10)} ${t.toFixed(2).padStart(9)} ms `
    + `${Math.floor(500 / t).toString().padStart(16)}`);
}

// --- what it misses --------------------------------------------------------
// A thin feature between rays is invisible. Model it directly: fire N rays at
// a sphere of radius R from outside, and ask how small a feature can hide.
console.log('\nangular ray spacing, and the feature size it can miss at 1 m:');
console.log(`   ${'rays'.padStart(8)} ${'spacing (deg)'.padStart(14)} `
  + `${'missable feature'.padStart(18)}`);
for (const rays of [64, 256, 1024, 4096, 16384]) {
  // uniform over a sphere: solid angle per ray = 4pi/N, cone half-angle:
  const halfAngle = Math.acos(1 - 2 / rays);
  const deg = halfAngle * 180 / Math.PI;
  const mm = 2 * Math.tan(halfAngle) * 1000;
  console.log(`   ${String(rays).padStart(8)} ${deg.toFixed(2).padStart(14)} `
    + `${mm.toFixed(1).padStart(15)} mm`);
}
