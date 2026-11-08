# Shared turn request identity proof

## Contract and scope

`startTurn(input)` returns a handle whose request ID identifies that turn for
submission and cancellation, even if the caller subsequently reuses `input`.
The change captures only `requestId`; it leaves other inputs, queue admission,
accepted/settled guards, IPC, retries and idempotency unchanged.

Base: `af67042fac736e8c1d0cd9dd4b8057fcee85d46d`.

## Observed public-runtime witness

A synthetic protocol peer holds active turn A and queued turn B. The caller
waits for B's actual admission on the same owner generation before cancelling
A. It then explicitly releases the surviving turn. A separate stable-input
case provides the control. No provider, model or external tool is invoked.

On the base, mutating A's original input to B's request ID causes A's handle to
send B's ID in `cancel_prompt`: B is cancelled before starting and A completes.
The stable-input control cancels A and lets B complete.

The candidate ran the same five fixture files without modification. Both cases
cancel A and let B complete; the returned IDs agree with the submitted IDs and
cancellation target. The run took 15.02 seconds. Both sessions closed through
the public runtime, owner leases and sockets disappeared, the unrelated
synthetic sibling survived each session close and then stopped normally, and
all 26 observed process identities retired. The outer controller joined stdout
and stderr without rescue. This is synthetic local runtime proof, not live
provider or native terminal qualification.

Fixture SHA-256 values:

| File           | SHA-256                                                            |
| -------------- | ------------------------------------------------------------------ |
| `identity.mjs` | `6f80a0eb4621f5908fec3bc663b4be73cdde550ebd067cc48229d474e335fce2` |
| `peer.mjs`     | `5977967cefd56596b5beb8d991d3bbfdd9b898f64c202a9d008bae48a0b8a529` |
| `sibling.mjs`  | `0a4018032e69bbb51bc9aa2930377a68f07e2604a990c5251036b82cb3650f9c` |
| `caller.mjs`   | `967cc92a25937f4b2b1ca3a053e86812d7881514ecaf1062fd08d9098d174703` |
| `launch.py`    | `42c3cdf516c90ea1c5df100703a85ef7627d03045a7bf7529814795f39f38dd4` |

## Maintained regression

`test/shared-runtime.test.ts` covers input mutation before asynchronous
submission and input reuse after A starts but before A cancels queued B.
The latter waits for the real owner's queue depth and generation and uses
release files to hold both prompts. Existing queue identity/cancellation tests
are retained unchanged.

Validation results and the exact review head are recorded in the pull request.
Merge remains a maintainer decision.
