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

### 2. Missing adapter path

If the adapter package is not installed locally, `acpx` still needs a way to
make the built-in agent usable.

The important rule is that this must remain ACPX-owned behavior. Downstream
callers such as OpenClaw should not solve missing built-in adapters by adding
their own default launcher logic or by bundling those adapters unconditionally.

In the short term, a dynamic fallback path is acceptable if ACPX needs one to
stay practical as a small CLI.

However, that is not the cleanest end state. The cleaner long-term model is:

- ACPX owns an explicit adapter cache or install area
- ACPX knows how to materialize the pinned built-in adapter into that location
- ACPX then launches the materialized adapter directly with `process.execPath`

That is cleaner than relying on implicit `npx` or `npm exec` behavior every
time a built-in adapter is missing.

## Default install policy

Built-in adapters such as Claude ACP and Codex ACP should not be installed by
default just because an application embeds `acpx`.

That means:

- do not add built-in adapter packages as default runtime dependencies of
  downstream embeddings such as OpenClaw
- do not solve this by making every OpenClaw install carry Claude ACP or Codex
  ACP up front
- keep adapter materialization, caching, install, and fallback behavior owned
  by `acpx`

If a local adapter is already present, `acpx` should use it. If it is not
present, `acpx` should decide how to fetch, install, or prepare it through its
own built-in path.

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
- No requirement that embedding apps install built-in adapters by default just
  to make `acpx` work.
- No special-case launcher policy owned in downstream integrations just because
  one environment is unusual.
- No claim that implicit `npx`-style fallback is the ideal long-term design.

## Desired end state

The clean end state is:

- built-in agent ownership lives in `acpx`
- built-in adapter pins live in `acpx`
- local installed adapters are launched directly with the current Node runtime
- when an adapter is missing, ACPX owns the explicit materialization path
- downstream embeddings do not install built-in adapters by default
- downstream embeddings do not redefine built-in launch behavior
- child startup crashes fail clearly instead of appearing stuck

If ACPX temporarily keeps a dynamic fallback while moving toward that model,
that fallback should be treated as a compatibility bridge, not as the ideal
architecture.

That keeps `acpx` small while still making built-in agent execution reliable in
both direct CLI use and embedded runtime use.
