// M3.C sandbox runner. docs/VERIFICATION_MODULES.md M3.C + docs/SECURITY.md §2.1 ("never
// execute [...] on the host"). Delivered code never runs on this process - it only ever runs
// inside a disposable, network-isolated Docker container, destroyed per invocation. This module
// owns the Docker lifecycle (materialize -> run detached -> wait with a wall-clock budget ->
// kill/rm); src/modules/m3-code.ts owns what command to run and how to interpret the result.
//
// Isolation primitive (locked this session, live-verified before this file was written - see
// CLAUDE_HISTORY.md Session 8): real Docker, not a downgraded story. `--network none`
// (external connect fails immediately), `--user 1000:1000` (confirmed non-root), `--memory`
// (confirmed real OOMKilled), `--pids-limit` (confirmed fork-bomb containment via EAGAIN) were
// each individually exercised live. One operational gotcha found live: `docker run --rm` in the
// foreground, killed via an external process timeout, does NOT stop the container - it keeps
// running server-side after the CLI client dies (two orphaned infinite-loop containers had to be
// manually killed during that investigation). This runner always runs detached (`docker run
// -d`), tracks the container id, and explicitly kills+removes it - never relies on the caller's
// own timeout reaching the container.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve, sep } from "node:path";

export const SANDBOX_IMAGE = "vidimus-sandbox-node:latest";

const WALL_CLOCK_TIMEOUT_MS = 15_000;
const MEMORY_LIMIT = "256m";
const CPU_LIMIT = "1";
const PIDS_LIMIT = "64";
// Budget for the docker CLI plumbing calls themselves (image inspect, run -d, kill, rm, logs,
// inspect) - not the sandboxed job's own wall clock, which is WALL_CLOCK_TIMEOUT_MS above.
const DOCKER_CLI_TIMEOUT_MS = 10_000;

export interface SandboxFile {
  path: string; // must already be validated relative-safe by quarantine; re-validated here too.
  content: string;
}

export interface SandboxRunResult {
  ok: boolean; // false: the sandbox itself could not run this job at all (image missing, docker unreachable, etc.)
  blockedReason?: string; // set iff ok=false
  exitCode: number | null;
  oomKilled: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function execCapture(cmd: string, args: string[], timeoutMs = DOCKER_CLI_TIMEOUT_MS): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: stderr || `spawn error: ${err.message}` });
    });
  });
}

async function imageExists(image: string): Promise<boolean> {
  const { code } = await execCapture("docker", ["image", "inspect", image]);
  return code === 0;
}

// Defense in depth beyond quarantine's own path validation (src/security/quarantine.ts) - never
// trust a single validation layer for something that becomes a real filesystem write location
// before the container (and its own isolation) even starts.
function safeJoin(root: string, relPath: string): string {
  const target = resolve(root, relPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`sandbox: rejected unsafe file path "${relPath}"`);
  }
  return target;
}

async function materialize(files: SandboxFile[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vidimus-sandbox-"));
  for (const file of files) {
    const target = safeJoin(dir, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  return dir;
}

function blocked(reason: string): SandboxRunResult {
  return { ok: false, blockedReason: reason, exitCode: null, oomKilled: false, timedOut: false, stdout: "", stderr: "" };
}

/**
 * Runs `argv` (already-split, never shell-interpolated - avoids any shell-injection surface via
 * crafted delivered filenames) inside a fresh, disposable container with `files` read-only
 * mounted at /workspace. Always destroys the container and the scratch dir, even on
 * error/timeout (VERIFICATION_MODULES.md M3.C: "destroyed per run", no exceptions).
 */
export async function runSandboxed(files: SandboxFile[], argv: string[]): Promise<SandboxRunResult> {
  if (!(await imageExists(SANDBOX_IMAGE))) {
    return blocked(`sandbox image "${SANDBOX_IMAGE}" is not built (run: npm run sandbox:build)`);
  }

  let workDir: string | undefined;
  let containerId: string | undefined;
  try {
    workDir = await materialize(files);

    const runArgs = [
      "run",
      "-d",
      "--network",
      "none",
      "--memory",
      MEMORY_LIMIT,
      "--memory-swap",
      MEMORY_LIMIT,
      "--cpus",
      CPU_LIMIT,
      "--pids-limit",
      PIDS_LIMIT,
      "--user",
      "1000:1000",
      "--read-only",
      "--tmpfs",
      "/tmp:size=64m,mode=1777",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${workDir}:/workspace:ro`,
      "-w",
      "/workspace",
      SANDBOX_IMAGE,
      ...argv,
    ];
    const started = await execCapture("docker", runArgs);
    if (started.code !== 0 || !started.stdout.trim()) {
      return blocked(`sandbox: docker run failed to start - ${started.stderr.trim() || "unknown error"}`);
    }
    containerId = started.stdout.trim();

    let timedOut = false;
    const waitPromise = execCapture("docker", ["wait", containerId], WALL_CLOCK_TIMEOUT_MS + DOCKER_CLI_TIMEOUT_MS);
    const timeoutPromise = new Promise<null>((resolvePromise) => setTimeout(() => resolvePromise(null), WALL_CLOCK_TIMEOUT_MS));
    const waited = await Promise.race([waitPromise, timeoutPromise]);

    let exitCode: number | null;
    if (waited === null) {
      timedOut = true;
      await execCapture("docker", ["kill", containerId]);
      exitCode = null;
    } else {
      const parsed = Number.parseInt(waited.stdout.trim(), 10);
      exitCode = Number.isNaN(parsed) ? null : parsed;
    }

    const [logs, inspect] = await Promise.all([
      execCapture("docker", ["logs", containerId]),
      execCapture("docker", ["inspect", containerId, "--format", "{{.State.OOMKilled}}"]),
    ]);

    return {
      ok: true,
      exitCode,
      oomKilled: inspect.stdout.trim() === "true",
      timedOut,
      stdout: logs.stdout,
      stderr: logs.stderr,
    };
  } catch (err) {
    return blocked(`sandbox: unexpected error - ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (containerId) {
      try {
        await execCapture("docker", ["rm", "-f", containerId]);
      } catch {
        // best-effort cleanup - nothing more we can do if this fails.
      }
    }
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup.
      }
    }
  }
}
