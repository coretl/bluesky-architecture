# Pinned references

Every claim in these documents about how something behaves was read against a
specific revision. Use these for permalinks, so a reader is looking at the same
code the claim was made about.

| Thing | Version / SHA |
|---|---|
| blueapi | `b767635920d1675bc4db58c6bbf80c29378aa3f7` |
| bluesky-queueserver | `0a084cfb722308f384847c24e6a43a8f572f302e` |
| scanspec `v2-dev` | `9a1d6364e09ce85788db0fa2839b638a143ba455` |
| ophyd-async | 0.20.1 |
| bluesky | 1.15.1 |
| diffcalc-core | as on PyPI, July 2026 |
| anti-collision service ([`garethnisbet/Robot`](https://github.com/garethnisbet/Robot)) | `f7875dd`, `master` |

## Specific things read, and where

Recorded because these are the load-bearing reads, and because a file that has
moved is easier to find again than a claim with no address.

**blueapi** — `src/blueapi/core/context.py`. Plan parameter injection is
`_convert_type` at `:305`, which builds the `Reference` pydantic type at `:250`
whose validator resolves a device *name* to the object. `register_device` at
`:208` gates on `is_bluesky_compatible_device`, and `Device` in
`core/bluesky_types.py:37` is a union of bluesky protocols — which is why a
non-device collaborator cannot be registered today.

**bluesky** — `src/bluesky/run_engine.py`. `preprocessors` is a constructor
argument at `:410`, stored as a mutable list at `:476`, and applied in
`__call__` at `:960`. `msg_hook` at `:1644` discards its return value, so it can
observe but never block. Note the composition order in the code disagrees with
the docstring at `:235`.

**ophyd-async** — `src/ophyd_async/core/_derived_signal_backend.py`. `Transform`
is at `:26`, generic over `RawT`/`DerivedT` with the methods declared under
`TYPE_CHECKING` at `:57`. `SignalTransformer` at `:80` already holds the
transform class, raw devices, raw constants and transform devices; they are just
not public. `DerivedSignalFactory` is in `_derived_signal.py:27`, and the
annotations on `raw_to_derived` are load-bearing — `:66` type-checks the wired
devices against them and `:283` derives the signal datatype from the return
annotation.

**anti-collision service** — `js/collision.js`. The mesh-vs-mesh test is
`testMeshPairCollision` at `:420` (AABB reject, then `intersectsGeometry`), the
point-cloud test is `testPointCloudCollision` at `:361`, and `fastWorldAABB` is
at `:343`. The worker mirrors all three from `:126`. `POINT_CLOUD_THRESHOLD` is
`0.04` in both files, and the cloud is decimated to at most 20,000 samples with
no reference to that threshold.
