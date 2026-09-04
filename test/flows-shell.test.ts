import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TimeoutError } from "../src/async-control.js";
import {
  formatShellActionSummary,
  renderShellCommand,
  resolveShellActionTimeoutMs,
  runShellAction,
} from "../src/flows/executors/shell.js";

function runHostScript(
  script: string,
  detached = false,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
      detached,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
  });
}

test("renderShellCommand quotes arguments consistently", () => {
  assert.equal(renderShellCommand("echo", ["hello", "two words"]), 'echo "hello" "two words"');
});

test("formatShellActionSummary prefixes rendered commands", () => {
  assert.equal(
    formatShellActionSummary({
      command: "git",
      args: ["status", "--short"],
    }),
    'shell: git "status" "--short"',
  );
});

test("runShellAction captures stdout and stderr", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", 'process.stdout.write("ok"); process.stderr.write("warn");'],
  });

  assert.equal(result.stdout, "ok");
  assert.equal(result.stderr, "warn");
  assert.equal(result.combinedOutput, "okwarn");
  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
});

test("runShellAction allows non-zero exits when requested", async () => {
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "process.exit(3)"],
    allowNonZeroExit: true,
  });

  assert.equal(result.exitCode, 3);
});

test("runShellAction rejects non-zero exits by default", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", 'process.stderr.write("boom"); process.exit(2)'],
      }),
    /Shell action failed/,
  );
});

test("runShellAction times out long-running commands", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10_000)"],
        timeoutMs: 50,
      }),
    (error: unknown) => error instanceof TimeoutError,
  );
});

test("resolveShellActionTimeoutMs treats non-positive as no deadline", () => {
  assert.equal(resolveShellActionTimeoutMs(undefined), undefined);
  assert.equal(resolveShellActionTimeoutMs(0), undefined);
  assert.equal(resolveShellActionTimeoutMs(-1), undefined);
  assert.equal(resolveShellActionTimeoutMs(50), 50);
  assert.equal(resolveShellActionTimeoutMs(Number.NaN), undefined);
  assert.equal(resolveShellActionTimeoutMs(Infinity), Infinity);
});

test("runShellAction treats timeoutMs 0 as no deadline", async () => {
  const started = Date.now();
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 80)"],
    timeoutMs: 0,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(Date.now() - started >= 70, "command should run to completion without a 1ms kill");
});

test("runShellAction reaps child when abort signal fires", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-abort-"));
  const pidFile = path.join(tmpDir, "pid");
  const ac = new AbortController();
  const pending = runShellAction(
    {
      command: process.execPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000)`,
      ],
    },
    { signal: ac.signal },
  );

  let pid: number | undefined;
  for (let i = 0; i < 50; i += 1) {
    try {
      pid = Number(await fs.readFile(pidFile, "utf8"));
      if (Number.isFinite(pid) && pid > 0) {
        break;
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(pid && pid > 0, "child should write pid");
  const childPid = pid;

  ac.abort();
  await assert.rejects(
    async () => await pending,
    (error: unknown) => error instanceof TimeoutError,
  );

  // Child must be reaped (process gone).
  await new Promise((r) => setTimeout(r, 50));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "aborted shell child should be reaped");
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test("runShellAction rejects commands terminated by signal", async () => {
  await assert.rejects(
    async () =>
      await runShellAction({
        command: "/bin/sh",
        args: ["-c", 'kill -TERM "$$"'],
      }),
    /signal SIGTERM/,
  );
});

test("runShellAction does not crash the host when the child exits before reading stdin", async () => {
  const moduleUrl = new URL("../src/flows/executors/shell.js", import.meta.url).href;
  const host = await runHostScript(`
    import { runShellAction } from ${JSON.stringify(moduleUrl)};
    const result = await runShellAction({
      command: process.execPath,
      args: ["-e", "setImmediate(() => process.exit(0))"],
      stdin: "x".repeat(1024 * 1024),
      allowNonZeroExit: true,
    });
    process.stdout.write(JSON.stringify({
      exitCode: result.exitCode,
      signal: result.signal,
    }));
  `);

  assert.equal(host.exitCode, 0, host.stderr);
  assert.doesNotMatch(host.stderr, /EPIPE|uncaughtException|Unhandled/);
  const payload = JSON.parse(host.stdout) as { exitCode: number | null; signal: string | null };
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.signal, null);
});

for (const detached of [false, true]) {
  test(`shell abort stops descendants after wrapper exit (detached=${detached})`, async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-tree-"));
    const pidFile = path.join(dir, "descendant.pid");
    const controller = new AbortController();
    const descendant = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`;
    const wrapper = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore',detached:${detached}});setInterval(()=>{},1000)`;
    const wrapperFile = path.join(dir, "wrapper.cjs");
    await fs.writeFile(wrapperFile, wrapper);
    const pending = runShellAction(
      { command: process.execPath, args: [wrapperFile], shell: true, timeoutMs: 0 },
      { signal: controller.signal },
    );
    const rejected = assert.rejects(pending, TimeoutError);
    let pid: number | undefined;
    t.after(async () => {
      controller.abort();
      await rejected;
      if (pid) {
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      await fs.rm(dir, { recursive: true, force: true });
    });
    {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        try {
          const candidate = Number(await fs.readFile(pidFile, "utf8"));
          if (Number.isInteger(candidate) && candidate > 1) {
            pid = candidate;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(pid && pid > 0, "descendant must start before abort");
      controller.abort();
      await rejected;
      const childPid = pid;
      if (process.platform === "win32") {
        assert.throws(() => process.kill(childPid, 0), { code: "ESRCH" });
      } else {
        const observed = spawnSync("ps", ["-p", String(childPid), "-o", "stat="], {
          encoding: "utf8",
        });
        assert.ifError(observed.error);
        assert.ok(
          observed.status === 1 || observed.stdout.trim().startsWith("Z"),
          `descendant is still running: ${observed.stdout}`,
        );
      }
    }
  });
}

test("shell cancellation before launch preserves the cancellation reason", async () => {
  const controller = new AbortController();
  const reason = new TimeoutError(10);
  controller.abort(reason);
  await assert.rejects(
    runShellAction({ command: "this-must-not-be-spawned" }, { signal: controller.signal }),
    (error) => error === reason,
  );
});

test("shell spawn errors remain authoritative with cancellation enabled", async () => {
  await assert.rejects(
    runShellAction(
      { command: "/nonexistent/acpx-shell-proof" },
      { signal: new AbortController().signal },
    ),
    { code: "ENOENT" },
  );
});

test("normal shell exit preserves completion with inherited descendant pipes", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "acpx-shell-normal-exit-"));
  const pidFile = path.join(dir, "child.pid");
  const child = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setTimeout(()=>{},1500)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});process.exit(0)`;
  t.after(async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const pid = Number(await fs.readFile(pidFile, "utf8"));
        if (!Number.isInteger(pid) || pid <= 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          continue;
        }
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const result = await runShellAction({
    command: process.execPath,
    args: ["-e", parent],
    timeoutMs: 500,
  });
  assert.equal(result.exitCode, 0);
});

test(
  "failed process inspection still kills the shell and reports the cleanup error",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/executors/shell.js", import.meta.url).href;
    const host = await runHostScript(`
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import {runShellAction} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-shell-probe-failure-'));
    const pidFile=path.join(dir,'pid');
    const controller=new AbortController();
    const script="process.on('SIGTERM',()=>{});require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setInterval(()=>{},1000)";
    const pending=runShellAction({command:process.execPath,args:['-e',script],timeoutMs:0},{signal:controller.signal}).catch(error=>error);
    let pid;
    try {
      for(let i=0;i<250;i++) {
        try {const value=Number(await fs.readFile(pidFile,'utf8'));if(Number.isInteger(value)&&value>1){pid=value;break;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!pid)throw new Error('child did not start');
      process.env.PATH='/nonexistent/acpx-process-probe';
      controller.abort();
      const error=await pending;
      let alive=true;try{process.kill(pid,0);}catch(error){if(error.code!=='ESRCH')throw error;alive=false;}
      process.stdout.write(JSON.stringify({code:error.code,alive}));
    } finally {
      controller.abort();
      await pending;
      if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      await fs.rm(dir,{recursive:true,force:true});
    }
  `);
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), { code: "ENOENT", alive: false });
  },
);

test(
  "POSIX flow interruption forwards SIGINT and waits for shell cleanup",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/runtime.js", import.meta.url).href;
    const host = await runHostScript(`
    import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
    import {FlowRunner,defineFlow,shell} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-flow-interrupt-'));const pidFile=path.join(dir,'pid');const marker=path.join(dir,'sigint');
    const runner=new FlowRunner({resolveAgent:()=>({agentName:'unused',agentCommand:'unused',cwd:dir}),permissionMode:'deny-all',outputRoot:dir});
    const script="process.on('SIGINT',()=>{require('node:fs').writeFileSync("+JSON.stringify(marker)+",'SIGINT');process.exit(0)});process.on('SIGTERM',()=>{});require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setInterval(()=>{},1000)";
    const flow=defineFlow({name:'interrupt',startAt:'work',nodes:{work:shell({timeoutMs:0,exec:()=>({command:process.execPath,args:['-e',script],timeoutMs:0})})},edges:[]});
    const pending=runner.run(flow,{}).catch(error=>error);let pid;
    try {
      for(let i=0;i<250;i++){
        try{const value=Number(await fs.readFile(pidFile,'utf8'));if(Number.isInteger(value)&&value>1){pid=value;break;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!pid)throw new Error('child did not start');
      process.kill(process.pid,'SIGINT');
      const error=await pending;
      let alive=true;try{process.kill(pid,0);}catch(error){if(error.code!=='ESRCH')throw error;alive=false;}
      const sigintReceived=await fs.readFile(marker,'utf8');
      process.stdout.write(JSON.stringify({error:error.name,alive,sigintReceived}));
    }finally{
      if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      await pending;
      await fs.rm(dir,{recursive:true,force:true});
    }
  `);
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), {
      error: "InterruptedError",
      alive: false,
      sigintReceived: "SIGINT",
    });
  },
);

test(
  "an interrupted pending shell executor cannot launch later",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/runtime.js", import.meta.url).href;
    const host = await runHostScript(`
    import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
    import {FlowRunner,defineFlow,shell} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-flow-interrupt-late-'));const marker=path.join(dir,'must-not-exist');
    let entered,release;const ready=new Promise(resolve=>entered=resolve);const gate=new Promise(resolve=>release=resolve);
    const runner=new FlowRunner({resolveAgent:()=>({agentName:'unused',agentCommand:'unused',cwd:dir}),permissionMode:'deny-all',outputRoot:dir});
    const script="require('node:fs').writeFileSync("+JSON.stringify(marker)+",'launched')";
    const flow=defineFlow({name:'interrupt-late',startAt:'work',nodes:{work:shell({timeoutMs:0,exec:async()=>{entered();await gate;return{command:process.execPath,args:['-e',script],timeoutMs:0};}})},edges:[]});
    const pending=runner.run(flow,{}).catch(error=>error);
    await ready;process.kill(process.pid,'SIGINT');const error=await pending;release();
    await new Promise(resolve=>setTimeout(resolve,100));
    let launched=true;try{await fs.access(marker);}catch(error){if(error.code!=='ENOENT')throw error;launched=false;}
    process.stdout.write(JSON.stringify({error:error.name,launched}));
    await fs.rm(dir,{recursive:true,force:true});
  `);
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), { error: "InterruptedError", launched: false });
  },
);

test(
  "foreground interruption reaches descendants after normal shell completion",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/runtime.js", import.meta.url).href;
    const host = await runHostScript(
      `
    import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
    import {FlowRunner,defineFlow,shell,compute} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-flow-background-signal-'));const pidFile=path.join(dir,'pid');const marker=path.join(dir,'signal');
    const child="process.on('SIGINT',()=>{require('node:fs').writeFileSync("+JSON.stringify(marker)+",'SIGINT');process.exit(0)});require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setInterval(()=>{},1000)";
    const wrapper="require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(child)+"],{stdio:'ignore'});process.exit(0)";
    let entered;const ready=new Promise(resolve=>entered=resolve);
    const runner=new FlowRunner({resolveAgent:()=>({agentName:'unused',agentCommand:'unused',cwd:dir}),permissionMode:'deny-all',outputRoot:dir});
    const flow=defineFlow({name:'background-signal',startAt:'launch',nodes:{launch:shell({timeoutMs:0,exec:()=>({command:process.execPath,args:['-e',wrapper],timeoutMs:0})}),waiting:compute({timeoutMs:0,run:()=>{entered();return new Promise(()=>{});}})},edges:[{from:'launch',to:'waiting'}]});
    const pending=runner.run(flow,{}).catch(error=>error);let pid;
    try {
      await ready;
      for(let i=0;i<250;i++){
        try{const value=Number(await fs.readFile(pidFile,'utf8'));if(Number.isInteger(value)&&value>1){pid=value;break;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!pid)throw new Error('descendant did not start');
      process.kill(-process.pid,'SIGINT');
      const error=await pending;let received=false;
      for(let i=0;i<100;i++){
        try{received=(await fs.readFile(marker,'utf8'))==='SIGINT';break;}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      process.stdout.write(JSON.stringify({error:error.name,received}));
    }finally{
      if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      await fs.rm(dir,{recursive:true,force:true});
    }
    process.exit(0);
  `,
      true,
    );
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), { error: "InterruptedError", received: true });
  },
);

test(
  "foreground Ctrl-C retains detached descendants when the wrapper exits on SIGINT",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/runtime.js", import.meta.url).href;
    const host = await runHostScript(
      `
    import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
    import {FlowRunner,defineFlow,shell} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-shell-wrapper-race-'));const pidFile=path.join(dir,'pid');const marker=path.join(dir,'wrapper-signal');
    const descendant="process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setInterval(()=>{},1000)";
    const wrapper="process.on('SIGINT',()=>{require('node:fs').writeFileSync("+JSON.stringify(marker)+",'SIGINT');process.exit(0)});require('node:child_process').spawn(process.execPath,['-e',"+JSON.stringify(descendant)+"],{stdio:'ignore',detached:true});setInterval(()=>{},1000)";
    const runner=new FlowRunner({resolveAgent:()=>({agentName:'unused',agentCommand:'unused',cwd:dir}),permissionMode:'deny-all',outputRoot:dir});
    const flow=defineFlow({name:'wrapper-race',startAt:'work',nodes:{work:shell({timeoutMs:0,exec:()=>({command:process.execPath,args:['-e',wrapper],timeoutMs:0})})},edges:[]});
    const pending=runner.run(flow,{}).catch(error=>error);let pid;
    try {
      for(let i=0;i<250;i++){
        try{const value=Number(await fs.readFile(pidFile,'utf8'));if(Number.isInteger(value)&&value>1){pid=value;break;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!pid)throw new Error('descendant did not start');
      process.kill(-process.pid,'SIGINT');const error=await pending;
      let alive=true;try{process.kill(pid,0);}catch(error){if(error.code!=='ESRCH')throw error;alive=false;}
      const handled=await fs.readFile(marker,'utf8');
      process.stdout.write(JSON.stringify({error:error.name,alive,handled}));
    }finally{
      if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      await pending;await fs.rm(dir,{recursive:true,force:true});
    }
  `,
      true,
    );
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), {
      error: "InterruptedError",
      alive: false,
      handled: "SIGINT",
    });
  },
);

test(
  "one foreground Ctrl-C delivers one graceful interrupt to the shell",
  { skip: process.platform === "win32" },
  async () => {
    const moduleUrl = new URL("../src/flows/runtime.js", import.meta.url).href;
    const host = await runHostScript(
      `
    import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
    import {FlowRunner,defineFlow,shell} from ${JSON.stringify(moduleUrl)};
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'acpx-shell-one-interrupt-'));const pidFile=path.join(dir,'pid');const marker=path.join(dir,'cleaned');
    const script="let count=0;process.on('SIGINT',()=>{if(++count>1)process.exit(2);setTimeout(()=>{require('node:fs').writeFileSync("+JSON.stringify(marker)+",String(count));process.exit(0)},200)});require('node:fs').writeFileSync("+JSON.stringify(pidFile)+",String(process.pid));setInterval(()=>{},1000)";
    const runner=new FlowRunner({resolveAgent:()=>({agentName:'unused',agentCommand:'unused',cwd:dir}),permissionMode:'deny-all',outputRoot:dir});
    const flow=defineFlow({name:'one-interrupt',startAt:'work',nodes:{work:shell({timeoutMs:0,exec:()=>({command:process.execPath,args:['-e',script],timeoutMs:0})})},edges:[]});
    const pending=runner.run(flow,{}).catch(error=>error);let pid;
    try{
      for(let i=0;i<250;i++){
        try{const value=Number(await fs.readFile(pidFile,'utf8'));if(Number.isInteger(value)&&value>1){pid=value;break;}}
        catch(error){if(error.code!=='ENOENT')throw error;}
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      if(!pid)throw new Error('child did not start');
      process.kill(-process.pid,'SIGINT');const error=await pending;
      const count=await fs.readFile(marker,'utf8');
      process.stdout.write(JSON.stringify({error:error.name,count}));
    }finally{
      if(pid){try{process.kill(pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}
      await pending;await fs.rm(dir,{recursive:true,force:true});
    }
  `,
      true,
    );
    assert.equal(host.exitCode, 0, host.stderr);
    assert.deepEqual(JSON.parse(host.stdout), { error: "InterruptedError", count: "1" });
  },
);
