// JS side of the language-vs-algorithm comparison. Reads the exact same
// decimated meshes bench_lang_prep.py wrote and timed with FCL.
//
// Also compares three-mesh-bvh's default CENTER split against SAH, since tree
// quality is a tuning choice rather than a property of the language.

import * as THREE from 'three';
import { MeshBVH, CENTER, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync(process.argv[2], 'utf8'));

function geom(spec) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position',
    new THREE.BufferAttribute(new Float32Array(spec.vertices), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(spec.faces), 1));
  g.computeBoundingBox();
  return g;
}

function mat(m) {
  // python row-major 4x4 -> three.js Matrix4
  return new THREE.Matrix4().set(...m.flat());
}

const Ta = mat(data.Ta), Tb = mat(data.Tb);
const relative = new THREE.Matrix4().copy(Ta).invert().multiply(Tb);

console.log(`pair: ${data.pair[0]} vs ${data.pair[1]}`);
console.log(
  `${'tris/mesh'.padStart(10)} ${'JS CENTER'.padStart(12)} ${'JS SAH'.padStart(12)} ` +
  `${'FCL'.padStart(11)} ${'ratio (SAH/FCL)'.padStart(16)}`);

const sizes = Object.keys(data.A).map(Number).sort((a, b) => a - b);
for (const n of sizes) {
  const ga = geom(data.A[String(n)]);
  const gb = geom(data.B[String(n)]);

  const timings = {};
  for (const [label, strategy] of [['CENTER', CENTER], ['SAH', SAH]]) {
    ga.boundsTree = new MeshBVH(ga, { strategy });
    gb.boundsTree = new MeshBVH(gb, { strategy });

    // warm up properly - V8 needs the function hot before it is worth timing
    for (let i = 0; i < 50; i++) ga.boundsTree.intersectsGeometry(gb, relative);

    const iters = Math.max(20, Math.round(4000 / Math.max(1, n / 500)));
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) ga.boundsTree.intersectsGeometry(gb, relative);
    timings[label] = (performance.now() - t0) / iters * 1000; // us
  }

  const fcl = data.fcl_us[String(n)];
  console.log(
    `${String(n).padStart(10)} ${timings.CENTER.toFixed(1).padStart(10)} us ` +
    `${timings.SAH.toFixed(1).padStart(10)} us ${fcl.toFixed(1).padStart(9)} us ` +
    `${(timings.SAH / fcl).toFixed(1).padStart(15)}x`);
}
