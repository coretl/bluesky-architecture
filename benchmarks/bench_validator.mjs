// Validator options at 10 Hz: discrete, or swept capsules with an arc bound.
//
// A sphere on a rotating link traces an arc, so its swept volume between two
// samples is a torus segment - a "banana". Torus-torus intersection is not
// worth it; instead bound the arc by its chord plus the sagitta, which turns
// the banana back into a capsule and the test into segment-segment distance.
//
// The subtlety this measures: a sphere near the end of the chain is moved by
// every joint above it, so its path is a composition of rotations, not one
// arc. The bound must sum each ancestor joint's contribution:
//
//     L        = sum over ancestor joints j of  d_j * |dtheta_j|      (path length)
//     inflate  = L / 2
//
// where d_j is the sphere's distance from joint j's world axis. The sagitta
// form d_j*(1-cos(dtheta_j/2)) is tighter and is what a single arc needs, but
// it is NOT conservative for a chain: rotating an upstream joint also moves
// the downstream axes, so individual arc deviations do not compose additively.
// Measured, that form is violated by up to 3.9 mm on this machine.
//
// The path-length form is rigorous for any path: a point q on a path of length
// L from p0 to p1 has |q-p0| + |q-p1| <= L, and its distance to the chord is at
// most min(|q-p0|, |q-p1|) <= L/2. Unlike a velocity guess it is computed per
// interval from the actual commanded motion.
//
// Checked numerically below against densely sampled ground truth before any of
// it is timed.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { readFileSync } from 'node:fs';

const [glbPath, cfgPath] = process.argv.slice(2);
const RATE = Number(process.env.RATE ?? 10);          // validator sample rate, Hz
const WMAX = Number(process.env.WMAX ?? 1.6);         // rad/s per joint
const K = Number(process.env.K ?? 8);                 // spheres per mesh
const INTERVALS = Number(process.env.INTERVALS ?? 2000);

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
// movable ancestors of a joint, including itself
function ancestors(jointIdx) {
  const out = [];
  for (let i = jointIdx; i >= 0; i = config.joints[i].parent ?? -1) {
    if (!config.joints[i].fixed) out.push(i);
    if (config.joints[i].parent === undefined) break;
  }
  return out;
}

// ---- spheres: centroid clusters, radius grown to cover assigned triangles --
function fitSpheres(geom, k) {
  const pos = geom.getAttribute('position'), idx = geom.index;
  const nTri = idx ? idx.count / 3 : pos.count / 3;
  const cent = new Float64Array(nTri * 3), vi = new Int32Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    for (let c = 0; c < 3; c++) vi[t * 3 + c] = idx ? idx.getX(t * 3 + c) : t * 3 + c;
    for (let d = 0; d < 3; d++) {
      const f = d === 0 ? 'getX' : d === 1 ? 'getY' : 'getZ';
      cent[t * 3 + d] = (pos[f](vi[t*3]) + pos[f](vi[t*3+1]) + pos[f](vi[t*3+2])) / 3;
    }
  }
  const lo = [Infinity,Infinity,Infinity], hi = [-Infinity,-Infinity,-Infinity];
  for (let t = 0; t < nTri; t++) for (let d = 0; d < 3; d++) {
    lo[d] = Math.min(lo[d], cent[t*3+d]); hi[d] = Math.max(hi[d], cent[t*3+d]);
  }
  const seeds = [];
  for (let s = 0; s < k; s++) {
    const f = k === 1 ? 0.5 : s / (k - 1);
    seeds.push([lo[0]+f*(hi[0]-lo[0]), lo[1]+f*(hi[1]-lo[1]), lo[2]+f*(hi[2]-lo[2])]);
  }
  const assign = new Int32Array(nTri);
  for (let it = 0; it < 12; it++) {
    for (let t = 0; t < nTri; t++) {
      let best = 0, bd = Infinity;
      for (let s = 0; s < k; s++) {
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
    for (let s = 0; s < k; s++) if (sum[s][3])
      seeds[s] = [sum[s][0]/sum[s][3], sum[s][1]/sum[s][3], sum[s][2]/sum[s][3]];
  }
  const rad = new Float64Array(k);
  for (let t = 0; t < nTri; t++) {
    const s = assign[t];
    for (let c = 0; c < 3; c++) {
      const v = vi[t*3+c];
      const dx=pos.getX(v)-seeds[s][0], dy=pos.getY(v)-seeds[s][1], dz=pos.getZ(v)-seeds[s][2];
      rad[s] = Math.max(rad[s], Math.hypot(dx, dy, dz));
    }
  }
  const out = [];
  for (let s = 0; s < k; s++) if (rad[s] > 0)
    out.push({ local: new THREE.Vector3(...seeds[s]), r: rad[s] });
  return out;
}

const bodies = meshes.map((m, i) => ({
  mesh: m,
  spheres: fitSpheres(m.geometry, K),
  anc: ancestors(owningJoint(m)),
}));
const nSpheres = bodies.reduce((s, b) => s + b.spheres.length, 0);
const movable = config.joints.map((j, i) => ({ j, i })).filter(x => !x.j.fixed);

console.log(`${config.name}: ${meshes.length} bodies, ${nSpheres} spheres, `
  + `${movable.length} joints, ${RATE} Hz, |w|<=${WMAX} rad/s`);

// ---- joint world axis lines (for the distance-to-axis term) ---------------
const axisOrigin = [], axisDir = [];
function refreshAxes() {
  for (let i = 0; i < rotGroups.length; i++) {
    const m = rotGroups[i].matrixWorld;
    axisOrigin[i] = new THREE.Vector3().setFromMatrixPosition(m);
    axisDir[i] = axes[i].clone().transformDirection(m).normalize();
  }
}

// ---- pose driver -----------------------------------------------------------
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const demo = config.demoPose ?? config.joints.map(() => 0);
const angle = new Float64Array(config.joints.length);
const omega = new Float64Array(config.joints.length);

function setAngles() {
  for (const { i } of movable) rotGroups[i].setRotationFromAxisAngle(axes[i], angle[i]);
  root.updateMatrixWorld(true);
}
function newInterval() {
  for (const { j, i } of movable) {
    const [lo, hi] = j.limits ?? [-180, 180];
    const base = ((demo[i] ?? 0) + (rnd() * 2 - 1) * 20) * Math.PI / 180;
    angle[i] = Math.min(hi * Math.PI/180, Math.max(lo * Math.PI/180, base));
    omega[i] = (rnd() * 2 - 1) * WMAX;
  }
}

// ---- geometry helpers ------------------------------------------------------
const _v = new THREE.Vector3(), _w = new THREE.Vector3();
function distToAxis(p, i) {
  _v.copy(p).sub(axisOrigin[i]);
  const t = _v.dot(axisDir[i]);
  _w.copy(axisDir[i]).multiplyScalar(t);
  return _v.sub(_w).length();
}
function segSegDist2(p0, p1, q0, q1) {
  const d1x=p1.x-p0.x, d1y=p1.y-p0.y, d1z=p1.z-p0.z;
  const d2x=q1.x-q0.x, d2y=q1.y-q0.y, d2z=q1.z-q0.z;
  const rx=p0.x-q0.x, ry=p0.y-q0.y, rz=p0.z-q0.z;
  const a=d1x*d1x+d1y*d1y+d1z*d1z, e=d2x*d2x+d2y*d2y+d2z*d2z;
  const f=d2x*rx+d2y*ry+d2z*rz, c=d1x*rx+d1y*ry+d1z*rz, b=d1x*d2x+d1y*d2y+d1z*d2z;
  const den = a*e - b*b;
  let s = den > 1e-30 ? Math.min(1, Math.max(0, (b*f - c*e)/den)) : 0;
  let t = e > 1e-30 ? (b*s + f)/e : 0;
  if (t < 0) { t = 0; s = a > 1e-30 ? Math.min(1, Math.max(0, -c/a)) : 0; }
  else if (t > 1) { t = 1; s = a > 1e-30 ? Math.min(1, Math.max(0, (b-c)/a)) : 0; }
  const dx=(p0.x+s*d1x)-(q0.x+t*d2x), dy=(p0.y+s*d1y)-(q0.y+t*d2y), dz=(p0.z+s*d1z)-(q0.z+t*d2z);
  return dx*dx+dy*dy+dz*dz;
}

// snapshot sphere world positions into a flat array
function snapshot() {
  const out = [];
  for (const b of bodies) {
    const mat = b.mesh.matrixWorld;
    for (const s of b.spheres)
      out.push({ p: s.local.clone().applyMatrix4(mat), r: s.r, body: b });
  }
  return out;
}

// ---- soundness: does the bound actually cover the arc? --------------------
const dt = 1 / RATE;
let worstOvershoot = -Infinity, maxInflate = 0, sumInflate = 0, nInf = 0;
for (let k = 0; k < 300; k++) {
  newInterval();
  const a0 = Float64Array.from(angle);
  setAngles(); refreshAxes();
  const start = snapshot();
  // inflation bound, computed at interval start
  const infl = start.map(s => {
    let sum = 0;
    for (const j of s.body.anc) sum += distToAxis(s.p, j) * Math.abs(omega[j] * dt);
    return sum / 2;
  });
  for (const { i } of movable) angle[i] = a0[i] + omega[i] * dt;
  setAngles();
  const end = snapshot();
  // ground truth: densely sample the true path and compare each sphere's
  // actual deviation from the chord against the bound computed above
  const N = 64;
  for (let n = 1; n < N; n++) {
    const f = n / N;
    for (const { i } of movable) angle[i] = a0[i] + omega[i] * dt * f;
    setAngles();
    let si = 0;
    for (const b of bodies) {
      const mat = b.mesh.matrixWorld;
      for (const s of b.spheres) {
        const p = s.local.clone().applyMatrix4(mat);
        const d2 = segSegDist2(p, p, start[si].p, end[si].p);
        worstOvershoot = Math.max(worstOvershoot, Math.sqrt(d2) - infl[si]);
        si++;
      }
    }
  }
  for (const v of infl) { maxInflate = Math.max(maxInflate, v); sumInflate += v; nInf++; }
}
console.log(`\nbound check over 300 intervals x 64 samples:`);
console.log(`  worst (actual deviation - bound) = ${(worstOvershoot * 1000).toFixed(4)} mm `
  + `${worstOvershoot <= 0 ? '<= 0, bound HOLDS' : '> 0, BOUND VIOLATED'}`);
console.log(`  inflation: mean ${(sumInflate / nInf * 1000).toFixed(3)} mm, `
  + `max ${(maxInflate * 1000).toFixed(3)} mm`);

// ---- cost ------------------------------------------------------------------
const bodyPairs = [];
for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++)
  bodyPairs.push([i, j]);

function timeIt(fn, label) {
  for (let k = 0; k < 100; k++) fn();
  const t0 = performance.now();
  for (let k = 0; k < INTERVALS; k++) fn();
  const per = (performance.now() - t0) / INTERVALS;
  const hourScan = per * 3600 * RATE / 1000;
  console.log(`  ${label.padEnd(34)} ${(per * 1000).toFixed(1).padStart(8)} us/interval  `
    + `1-hour scan @${RATE}Hz = ${hourScan.toFixed(2)} s`);
  return per;
}

console.log(`\ncost, ${bodyPairs.length} body pairs, ${nSpheres} spheres:`);
newInterval(); setAngles(); refreshAxes();
const A = snapshot();
for (const { i } of movable) angle[i] += omega[i] * dt;
setAngles();
const B = snapshot();
const byBody = new Map();
A.forEach((s, i) => {
  const k = bodies.indexOf(s.body);
  if (!byBody.has(k)) byBody.set(k, []);
  byBody.get(k).push(i);
});
const inflAll = A.map(s => {
  let sum = 0;
  for (const j of s.body.anc) sum += distToAxis(s.p, j) * Math.abs(omega[j] * dt);
  return sum / 2;
});

timeIt(() => {
  let hits = 0;
  for (const [bi, bj] of bodyPairs) {
    for (const ia of byBody.get(bi) ?? []) for (const ib of byBody.get(bj) ?? []) {
      const t = A[ia].r + A[ib].r;
      const dx=A[ia].p.x-A[ib].p.x, dy=A[ia].p.y-A[ib].p.y, dz=A[ia].p.z-A[ib].p.z;
      if (dx*dx+dy*dy+dz*dz < t*t) { hits++; break; }
    }
  }
  return hits;
}, 'discrete spheres (endpoint only)');

timeIt(() => {
  let hits = 0;
  for (const [bi, bj] of bodyPairs) {
    for (const ia of byBody.get(bi) ?? []) for (const ib of byBody.get(bj) ?? []) {
      const t = A[ia].r + inflAll[ia] + A[ib].r + inflAll[ib];
      if (segSegDist2(A[ia].p, B[ia].p, A[ib].p, B[ib].p) < t * t) { hits++; break; }
    }
  }
  return hits;
}, 'swept capsules + arc bound');
