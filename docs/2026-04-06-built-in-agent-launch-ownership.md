---
title: acpx Built-in Agent Launch Ownership
description: Ownership and launch model for built-in ACP agent adapters.
author: OpenClaw Team <dev@openclaw.ai>
date: 2026-04-06
---

# acpx Built-in Agent Launch Ownership

## Why this document exists

`acpx` currently knows about built-in agents such as `codex` and `claude`, but
the actual launch behavior is not owned cleanly in one place.

That split becomes fragile when `acpx` is embedded inside another long-running
process, such as OpenClaw.

The immediate trigger for this note was a real integration failure where the
embedded Claude ACP child was launched under a different Node version than the
parent OpenClaw gateway process. The gateway itself was running on Node 22, but
the Claude ACP child ended up running on Node 18 and crashed during startup.

The underlying problem was not Claude-specific session logic. The underlying
problem was unclear ownership of built-in agent launch behavior.

## Core decision

`acpx` should fully own the built-in agent launcher contract.

That means `acpx` should be the single source of truth for:

- which ACP adapter package a built-in agent uses
- which adapter version is pinned
- how that adapter should be resolved
- how that adapter should be launched

Embedding applications such as OpenClaw should not carry their own separate
built-in launcher defaults for agents that `acpx` already defines.

## What this means in practice

When a caller asks for a built-in agent such as `claude` or `codex`, `acpx`
should resolve that request through built-in metadata owned inside `acpx`.

That metadata should not just be a loose command string. It should describe:

- adapter package name
- adapter entrypoint strategy
- launch strategy
- fallback behavior when the adapter is not installed locally

## Launch model

There should be two valid built-in launch modes.

### 1. Installed adapter path

If the adapter package is already installed locally, `acpx` should resolve its
entrypoint directly and launch it with the current Node binary.

In plain terms:

- resolve the installed adapter package
- resolve the adapter entry file
- run it with `process.execPath`

This is the preferred path for embedded and supervised runtimes because it is
deterministic and keeps the child on the same Node runtime as the parent.

### 2. Dynamic fallback path

If the adapter package is not installed locally, `acpx` may fall back to a
dynamic launcher path.

That fallback exists to keep `acpx` practical as a small CLI without requiring
every adapter package to be preinstalled for every user.

The fallback should still be owned by `acpx`, not by downstream callers.

## What embedding applications should do

Embedding applications should pass the built-in agent name and let `acpx`
decide how to launch it.

They may still provide an explicit override when a user has configured a custom
command, but they should not redefine the built-in default for `claude`,
`codex`, or other built-in agents that `acpx` already owns.

In other words:

- user override: embedding app may pass through
- built-in default: owned by `acpx`

## Error handling requirement

When an ACP child exits before initialize completes, `acpx` should fail fast
with a clear startup error.

It should not look like a silent hang.

This matters regardless of the specific agent because a child that crashes
before the ACP handshake completes is a launch failure, not a session
management problem.

## Non-goals

- No requirement that every built-in adapter be installed as a normal
  dependency of the `acpx` package.
- No requirement that embedding apps carry built-in adapter package logic of
  their own.
- No special-case launcher policy owned in downstream integrations just because
  one environment is unusual.

## Desired end state

The clean end state is:

- built-in agent ownership lives in `acpx`
- built-in adapter pins live in `acpx`
- local installed adapters are launched directly with the current Node runtime
- dynamic fallback remains available when local installation is absent
- downstream embeddings stop redefining built-in launch behavior
- child startup crashes fail clearly instead of appearing stuck

That keeps `acpx` small while still making built-in agent execution reliable in
both direct CLI use and embedded runtime use.
