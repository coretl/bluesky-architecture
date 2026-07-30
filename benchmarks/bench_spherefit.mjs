// How much conservatism does the sphere approximation itself add?
//
// Total padding at the coarse tier = sphere-fit error + motion inflation.
// bench_validator.mjs measured the motion inflation (3.3 mm mean at 200 Hz).
// This measures the other term, which nothing so far has: how far the sphere
// union sticks out beyond the mesh it covers.
//
// Method: sample points on each sphere's surface, and for each one ask the
// mesh BVH for the distance to the actual surface. That distance is empty
// space the coarse tier will treat as solid, so it is a direct false-positive
// driver in the same units as everything else.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, SAH } from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;

const [glbPath] = process.argv.slice(2);
const SAMPLES = Number(process.env.SAMPLES ?? 200);

const buf = readFileSync(glbPath);
const gltf = await new GLTFLoader().parseAsync(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
const meshes = [];
gltf.scene.traverse(o => {
  if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o);
});
for (const m of meshes) m.geometry.computeBoundsTree({ strategy: SAH });

function fitSpheres(geom, k) {
  const pos = geom.getAttribute('position'), idx = geom.index;
  const nTri = idx ? idx.count / 3 : pos.count / 3;
  const cent = new Float64Array(nTri * 3), vi = new Int32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    for (let c = 0; c < 3; c++) vi[t*3+c] = idx ? idx.getX(t*3+c) : t*3+c;
    for (let d = 0; d < 3; d++) {
      const f = d === 0 ? 'getX' : d === 1 ? 'getY' : 'getZ';
      cent[t*3+d] = (pos[f](vi[t*3]) + pos[f](vi[t*3+1]) + pos[f](vi[t*3+2])) / 3;
    }
  }
  const lo=[Infinity,Infinity,Infinity], hi=[-Infinity,-Infinity,-Infinity];
  for (let t = 0; t < nTri; t++) for (let d = 0; d < 3; d++) {
    lo[d]=Math.min(lo[d],cent[t*3+d]); hi[d]=Math.max(hi[d],cent[t*3+d]);
  }
  // k-means++ style spread seeding beats the linear seeding used earlier
  const seeds = [[cent[0], cent[1], cent[2]]];
  while (seeds.length < k) {
    let bi = 0, bd = -1;
    for (let t = 0; t < nTri; t++) {
      let dm = Infinity;
      for (const s of seeds) {
        const dx=cent[t*3]-s[0], dy=cent[t*3+1]-s[1], dz=cent[t*3+2]-s[2];
        dm = Math.min(dm, dx*dx+dy*dy+dz*dz);
      }
      if (dm > bd) { bd = dm; bi = t; }
    }
    seeds.push([cent[bi*3], cent[bi*3+1], cent[bi*3+2]]);
  }
  const assign = new Int32Array(nTri);
  for (let it = 0; it < 20; it++) {
    for (let t = 0; t < nTri; t++) {
      let best = 0, bd = Infinity;
      for (let s = 0; s < seeds.length; s++) {
        const dx=cent[t*3]-seeds[s][0], dy=cent[t*3+1]-seeds[s][1], dz=cent[t*3+2]-seeds[s][2];
        const d2 = dx*dx+dy*dy+dz*dz;
        if (d2 < bd) { bd = d2; best = s; }
      }
      assign[t] = best;
    }
    const sum = seeds.map(() => [0,0,0,0]);
    for (let t = 0; t < nTri; t++) {
      const s = sum[assign[t]];
      s[0]+=cent[t*3]; s[1]+=cent[t*3+1]; s[2]+=cent[t*3+2]; s[3]++;
    }
    for (let s = 0; s < seeds.length; s++) if (sum[s][3])
      seeds[s] = [sum[s][0]/sum[s][3], sum[s][1]/sum[s][3], sum[s][2]/sum[s][3]];
  }
  const rad = new Float64Array(seeds.length);
  for (let t = 0; t < nTri; t++) {
    const s = assign[t];
    for (let c = 0; c < 3; c++) {
      const v = vi[t*3+c];
      rad[s] = Math.max(rad[s], Math.hypot(
        pos.getX(v)-seeds[s][0], pos.getY(v)-seeds[s][1], pos.getZ(v)-seeds[s][2]));
    }
  }
  const out = [];
  for (let s = 0; s < seeds.length; s++) if (rad[s] > 0)
    out.push({ c: new THREE.Vector3(...seeds[s]), r: rad[s] });
  return out;
}

// deterministic near-uniform points on a unit sphere
const dirs = [];
for (let i = 0; i < SAMPLES; i++) {
  const y = 1 - (i / (SAMPLES - 1)) * 2;
  const rr = Math.sqrt(Math.max(0, 1 - y*y));
  const th = Math.PI * (1 + Math.sqrt(5)) * i;
  dirs.push(new THREE.Vector3(Math.cos(th)*rr, y, Math.sin(th)*rr));
}

const target = {}, pt = new THREE.Vector3();
console.log(`${glbPath.split('/').pop()}: sphere-fit error vs sphere count`);
console.log(`${'K/mesh'.padStart(7)} ${'spheres'.padStart(8)} ${'mean err'.padStart(10)} `
  + `${'p95 err'.padStart(10)} ${'max err'.padStart(10)}`);

for (const K of [4, 8, 16, 32, 64]) {
  let total = 0, n = 0, worst = 0;
  const all = [];
  let count = 0;
  for (const m of meshes) {
    const sph = fitSpheres(m.geometry, K);
    count += sph.length;
    const bvh = m.geometry.boundsTree;
    for (const s of sph) {
      for (const d of dirs) {
        pt.copy(d).multiplyScalar(s.r).add(s.c);
        const hit = bvh.closestPointToPoint(pt, target);
        if (!hit) continue;
        const dist = hit.distance;
        total += dist; n++; worst = Math.max(worst, dist); all.push(dist);
      }
    }
  }
  all.sort((a, b) => a - b);
  const p95 = all[Math.floor(all.length * 0.95)];
  console.log(`${String(K).padStart(7)} ${String(count).padStart(8)} `
    + `${(total/n*1000).toFixed(1).padStart(8)} mm ${(p95*1000).toFixed(1).padStart(8)} mm `
    + `${(worst*1000).toFixed(1).padStart(8)} mm`);
}
