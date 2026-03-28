import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveAcpxVersion } from "../src/version.js";

test("resolveAcpxVersion prefers npm_package_version from env when package name is acpx", () => {
  const version = resolveAcpxVersion({
    env: {
      npm_package_name: "acpx",
      npm_package_version: "9.9.9-ci",
    },
    packageJsonPath: "/definitely/missing/package.json",
  });
  assert.equal(version, "9.9.9-ci");
});

test("resolveAcpxVersion ignores npm_package_version from non-acpx package env", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-version-test-"));
  try {
    const packagePath = path.join(tmpDir, "package.json");
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ name: "acpx", version: "1.2.3" }, null, 2)}\n`,
      "utf8",
    );
    const version = resolveAcpxVersion({
      env: {
        npm_package_name: "openclaw",
        npm_package_version: "2026.2.25",
      },
      packageJsonPath: packagePath,
    });
    assert.equal(version, "1.2.3");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("resolveAcpxVersion reads version from package.json when env is unset", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-version-test-"));
  try {
    const packagePath = path.join(tmpDir, "package.json");
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ name: "acpx", version: "1.2.3" }, null, 2)}\n`,
      "utf8",
    );
    const version = resolveAcpxVersion({
      env: {},
      packageJsonPath: packagePath,
    });
    assert.equal(version, "1.2.3");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("resolveAcpxVersion falls back to unknown when version cannot be resolved", () => {
  const version = resolveAcpxVersion({
    env: {},
    packageJsonPath: "/definitely/missing/package.json",
  });
  assert.equal(version, "0.0.0-unknown");
});

test("resolveAcpxVersion ignores blank env versions and blank package versions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-version-test-"));
  try {
    const packagePath = path.join(tmpDir, "package.json");
    await fs.writeFile(
      packagePath,
      `${JSON.stringify({ name: "acpx", version: "   " }, null, 2)}\n`,
      "utf8",
    );
    const version = resolveAcpxVersion({
      env: {
        npm_package_name: "acpx",
        npm_package_version: "   ",
      },
      packageJsonPath: packagePath,
    });
    assert.equal(version, "0.0.0-unknown");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("getAcpxVersion caches the first resolved version", async () => {
  const versionModuleUrl = new URL(`../src/version.js?cachebust=${Date.now()}`, import.meta.url);
  const previousName = process.env.npm_package_name;
  const previousVersion = process.env.npm_package_version;

  process.env.npm_package_name = "acpx";
  process.env.npm_package_version = "7.8.9";

  try {
    const freshModule = (await import(versionModuleUrl.href)) as typeof import("../src/version.js");
    assert.equal(freshModule.getAcpxVersion(), "7.8.9");

    process.env.npm_package_version = "9.9.9";
    assert.equal(freshModule.getAcpxVersion(), "7.8.9");
  } finally {
    if (previousName === undefined) {
      delete process.env.npm_package_name;
    } else {
      process.env.npm_package_name = previousName;
    }
    if (previousVersion === undefined) {
      delete process.env.npm_package_version;
    } else {
      process.env.npm_package_version = previousVersion;
    }
  }
});
