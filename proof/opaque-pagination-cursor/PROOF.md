# Opaque session-list cursor proof

Base: `af67042fac736e8c1d0cd9dd4b8057fcee85d46d`.

The stable ACP SDK 1.9.0 schema describes `nextCursor` as an opaque token to pass
back as the next request's `cursor`. Both its response and request validators
accept the synthetic token `" page-2 "`. This proof does not claim that any
particular real adapter emits that token.

The same five-case witness ran against base and candidate source. It imports
the actual CLI registration, Commander parser, effective flag resolver,
session-list handler and `AcpClient` request construction. Only startup, close,
and the connection request receiver are replaced by a schema-valid test sink.
No adapter process, provider, network request or SDK transport is used.

| Case            | Base constructed request | Candidate constructed request |
| --------------- | ------------------------ | ----------------------------- |
| `page-2`        | `{"cursor":"page-2"}`    | `{"cursor":"page-2"}`         |
| `page-2`        | `{"cursor":"page-2"}`    | `{"cursor":" page-2 "}`       |
| Omitted         | `{}`                     | `{}`                          |
| Empty           | Rejected before request  | Rejected before request       |
| Whitespace only | Rejected before request  | Rejected before request       |

`base.json` and `candidate.json` retain the returned token, effective parsed
token, actual constructed request, schema checks, errors and startup counters.
`BINDING.json` gives runtime/source hashes and capture transformations.
`witness.mjs` is a formatting-only copy of the identical frozen witness used
for both runs; both hashes are in the binding. Its exit 1 on the
base is the expected contract failure; candidate exit 0 is the recovery.

The remaining rejection of empty or whitespace-only tokens is existing CLI
compatibility behavior, even though the protocol schema permits strings of
those forms. This change does not claim support for every schema-valid token.
Generic text, filter-cwd, session-name and watch-cursor parsing are unchanged.

## Maintained regression

`test/cli-flags.test.ts` exercises real registration through the same request
boundary, testing both parent and child option placement. The padded token
must survive; ordinary and omitted values must retain their behavior, and
blank arguments must still reject before startup or request dispatch.

To inspect the standalone witness, provide a JSON manifest with `sourceRoot`
pointing to a source checkout with its locked dependencies and `root` pointing
to a fresh disposable directory. Run Node with that checkout's `tsx` import
loader, followed by `witness.mjs` and the manifest path. The witness imports
source from that checkout and writes only its observation files under `root`.
It intentionally has no adapter launch path.

The initial qualification fixture read only child Commander options and failed
an observation assertion; the corrected fixture used the real effective flag
resolver. That preparation failure is retained in the task record. Separately,
the first test-compilation command preceded the package build and failed to
resolve generated `acpx/runtime` declarations; package-order build followed by
test compilation passed. Neither event is reported as a product-test success.

Full checks, coverage, CI and independent review results are recorded in the PR.
Merge remains a maintainer decision.
