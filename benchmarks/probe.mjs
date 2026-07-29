// Does the anti-collision path work with no WebGL context, no canvas, no DOM?
// Replicates what js/collision.js actually consumes:
//   - geometry.getAttribute('position').array   (CPU typed array from the loader)
//   - mesh.matrixWorld                          (CPU Object3D maths)
//   - three-mesh-bvh boundsTree                 (CPU BVH)
// The only thing collision.js gets from render() is the side effect of
// scene.updateMatrixWorld(), which we call directly here.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast, MeshBVH }
  from 'three-mesh-bvh';
import { readFileSync } from 'node:fs';

console.log('WebGL context available :', typeof WebGLRenderingContext !== 'undefined');
console.log('document available      :', typeof document !== 'undefined');
console.log('three                   :', THREE.REVISION);

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const file = process.argv[2];
const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
const gltf = await loader.parseAsync(ab, '');
const scene = gltf.scene;

// This is what render() was doing for collision.js. Pure CPU.
scene.updateMatrixWorld(true);

const meshes = [];
scene.traverse(o => { if (o.isMesh && o.geometry?.getAttribute('position')) meshes.push(o); });
console.log(`\nmeshes loaded           : ${meshes.length}`);

let tris = 0;
for (const m of meshes) {
  const g = m.geometry;
  tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
}
console.log(`triangles               : ${Math.round(tris).toLocaleString()}`);

// Build BVHs — the "assemble the scene" step, on CPU.
const t0 = performance.now();
for (const m of meshes) m.geometry.computeBoundsTree();
const tBuild = performance.now() - t0;
console.log(`BVH build (all meshes)  : ${tBuild.toFixed(1)} ms`);

// Confirm world matrices are real numbers, not identity placeholders.
const nonIdentity = meshes.filter(m => !m.matrixWorld.equals(new THREE.Matrix4())).length;
console.log(`meshes with non-identity matrixWorld : ${nonIdentity}/${meshes.length}`);

// Now the actual check collision.js does: mesh-vs-mesh BVH intersection in the
// local frame of A, exactly as js/collision.js line ~427 sets it up.
const mat = new THREE.Matrix4();
let pairs = 0, hits = 0;
const t1 = performance.now();
for (let i = 0; i < meshes.length; i++) {
  for (let j = i + 1; j < meshes.length; j++) {
    const a = meshes[i], b = meshes[j];
    mat.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
    const hit = a.geometry.boundsTree.intersectsGeometry(b.geometry, mat);
    pairs++;
    if (hit) hits++;
  }
}
const tCheck = performance.now() - t1;
console.log(`\nall-pairs check         : ${pairs} pairs in ${tCheck.toFixed(1)} ms `
          + `(${(tCheck / pairs).toFixed(2)} ms/pair), ${hits} intersecting`);

// Sweep a joint and re-check, which is what a trajectory batch would do.
const movable = meshes.find(m => m.parent && m.parent.type === 'Object3D') ?? meshes[0];
const t2 = performance.now();
const N = 200;
for (let k = 0; k < N; k++) {
  movable.rotation.z = (k / N) * Math.PI * 2;
  scene.updateMatrixWorld(true);
  const a = meshes[0], b = meshes[1];
  mat.copy(a.matrixWorld).invert().multiply(b.matrixWorld);
  a.geometry.boundsTree.intersectsGeometry(b.geometry, mat);
}
const tSweep = performance.now() - t2;
console.log(`${N}-pose sweep (1 pair)  : ${tSweep.toFixed(1)} ms `
          + `(${(tSweep / N).toFixed(3)} ms/pose incl. full updateMatrixWorld)`);

console.log('\nRESULT: completed with no WebGL context and no DOM.');
