import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import type { useAnalysisJob } from "../../src/hooks/useAnalysisJob.ts";
import { defaultDraft, toJobConfig } from "../../src/types/job.ts";

type Job = ReturnType<typeof useAnalysisJob>;
type Effect = { dependencies: unknown[]; cleanup?: void | (() => void) };
const config = (id: string) => toJobConfig({ ...defaultDraft, inputVideos: ["a.avi", "b.avi"] }, id);
const state = (job: Job) => Object.fromEntries(Object.entries(job).filter(([, value]) => typeof value !== "function"));

async function mountJob(t: TestContext) {
  const slots: unknown[] = [];
  const effects = new Map<number, Effect>();
  const pendingEffects: (() => void)[] = [];
  const listeners = new Map<string, (event: { payload: unknown }) => void>();
  const intervals = new Set<() => void>();
  const calls: { command: string; args: unknown; resolve: (value?: unknown) => void; reject: (reason: unknown) => void }[] = [];
  let cursor = 0;
  const mocks = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index], (action: T | ((value: T) => T)) => {
        slots[index] = typeof action === "function" ? (action as (value: T) => T)(slots[index] as T) : action;
      }];
    },
    useRef<T>(current: T) {
      const index = cursor++;
      return slots[index] ??= { current };
    },
    useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
      const index = cursor++;
      const previous = effects.get(index);
      if (previous && dependencies.length === previous.dependencies.length
        && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      const next: Effect = { dependencies };
      effects.set(index, next);
      pendingEffects.push(() => {
        previous?.cleanup?.();
        next.cleanup = effect();
      });
    },
    async listen(name: string, callback: (event: { payload: unknown }) => void) {
      listeners.set(name, callback);
      return () => { listeners.delete(name); };
    },
    invoke(command: string, args: unknown) {
      const pending = Promise.withResolvers<unknown>();
      calls.push({ command, args, ...pending });
      return pending.promise;
    },
  };

  // Only replace this hook's imports; Node executes the actual TypeScript source.
  const key = `__analysisJobTest_${crypto.randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  globals[key] = mocks;
  globals.window = {
    setInterval(callback: () => void) { intervals.add(callback); return callback; },
    clearInterval(callback: () => void) { intervals.delete(callback); },
  };
  const hookUrl = new URL(`../../src/hooks/useAnalysisJob.ts?test=${key}`, import.meta.url).href;
  const mockSource = `const mocks = globalThis[${JSON.stringify(key)}];\n`;
  const imports: Record<string, string> = {
    react: mockSource + "export const { useState, useRef, useEffect } = mocks;",
    "@tauri-apps/api/event": mockSource + "export const { listen } = mocks;",
    "@tauri-apps/api/core": mockSource + "export const { invoke } = mocks;",
    "../services/desktop": "export const isDesktopRuntime = () => true;",
  };
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (context.parentURL === hookUrl && Object.hasOwn(imports, specifier)) {
        return { url: `data:text/javascript,${encodeURIComponent(imports[specifier])}`, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => {
    loader.deregister();
    for (const effect of effects.values()) effect.cleanup?.();
    delete globals[key];
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globals.window;
  });
  const { useAnalysisJob: useHook } = await import(hookUrl) as { useAnalysisJob: typeof useAnalysisJob };
  loader.deregister();
  const read = () => {
    cursor = 0;
    const job = useHook();
    for (const effect of pendingEffects.splice(0)) effect();
    return job;
  };
  read();
  return {
    read, calls, intervals,
    tick() { for (const callback of intervals) callback(); },
    emit(name: string, payload: Record<string, unknown>) {
      assert.ok(listeners.has(name), `Missing listener: ${name}`);
      listeners.get(name)!({ payload });
    },
  };
}

test("reset clears completed results, progress, logs, timing, and stage metadata", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 10000 });
  const h = await mountJob(t);
  const initial = state(h.read());
  const run = config("completed-job");
  run.pipeline_params.COMPUTE_TUFT_STATS = false;
  run.pipeline_params.COMPUTE_METACHRONAL_AXIS = false;
  const start = h.read().start(run);
  assert.equal(h.calls[0].command, "start_analysis");
  assert.deepEqual(h.calls[0].args, { config: run });
  h.calls[0].resolve(run.job_id);
  await start;
  h.emit("sidecar-event", { job_id: run.job_id, event: "started", job_directory: "old/results", total_videos: 2 });
  h.emit("sidecar-event", { job_id: run.job_id, event: "stage", stage: "fft", video_path: "a.avi", message: "FFT" });
  h.emit("sidecar-event", { job_id: run.job_id, event: "artifact" });
  h.emit("sidecar-event", { job_id: run.job_id, event: "progress", fraction: 0.5, completed_videos: 1, failed_videos: 1, total_videos: 2 });
  h.emit("sidecar-log", { jobId: run.job_id, line: "old log" });
  h.read();
  t.mock.timers.tick(5000);
  h.tick();
  assert.equal(h.read().elapsedSeconds, 5);
  h.emit("sidecar-event", { job_id: run.job_id, event: "completed", completed_videos: 1, failed_videos: 1 });
  assert.equal(h.read().status, "completed_with_errors");
  assert.equal(h.read().jobDirectory, "old/results");
  h.read().reset();
  assert.deepEqual(state(h.read()), initial);
  assert.equal(h.intervals.size, 0);
});

test("reset ignores late sidecar, log, and host events while idle", async (t) => {
  const h = await mountJob(t);
  const start = h.read().start(config("old"));
  h.calls[0].resolve("old");
  await start;
  h.read().reset();
  const idle = state(h.read());
  for (const event of ["started", "stage", "progress", "artifact", "completed", "cancelled", "error"]) {
    h.emit("sidecar-event", { job_id: "old", event, job_directory: "stale", stage: "fft", message: "stale", fraction: 1, completed_videos: 2 });
    assert.deepEqual(state(h.read()), idle, event);
  }
  h.emit("sidecar-log", { jobId: "old", line: "stale log" });
  assert.deepEqual(state(h.read()), idle);
  for (const cancelled of [true, false]) {
    h.emit("host-job-exited", { jobId: "old", cancelled, success: false, exitCode: 1 });
    assert.deepEqual(state(h.read()), idle);
  }
});

for (const outcome of ["resolve", "reject"] as const) {
  test(`delayed start ${outcome} cannot revive a reset job`, async (t) => {
    const h = await mountJob(t);
    const start = h.read().start(config("old"));
    h.read().reset();
    const idle = state(h.read());
    h.calls[0][outcome](outcome === "resolve" ? "old" : new Error("late start failure"));
    await start;
    assert.deepEqual(state(h.read()), idle);
  });

  for (const reuseId of [false, true]) {
    test(`replacement job survives old start ${outcome}${reuseId ? " with a reused ID" : " and stale events"}`, async (t) => {
      const h = await mountJob(t);
      const oldStart = h.read().start(config("old"));
      h.read().reset();
      const replacementId = reuseId ? "old" : "new";
      const newStart = h.read().start(config(replacementId));
      const starting = state(h.read());
      if (!reuseId) {
        h.emit("sidecar-event", { job_id: "old", event: "completed", completed_videos: 2 });
        h.emit("sidecar-log", { jobId: "old", line: "stale log" });
        h.emit("host-job-exited", { jobId: "old", cancelled: false, success: false, exitCode: 1 });
      }
      h.calls[0][outcome](outcome === "resolve" ? "old" : new Error("late start failure"));
      await oldStart;
      assert.deepEqual(state(h.read()), starting);
      const duplicateStart = h.read().start(config("duplicate"));
      assert.equal(h.calls.length, 2, "replacement must keep the concurrent-start guard");
      await duplicateStart;
      h.calls[1].resolve(replacementId);
      await newStart;
      assert.equal(h.read().status, "running");
      h.emit("sidecar-event", { job_id: replacementId, event: "started", job_directory: "new/results", total_videos: 2 });
      h.emit("sidecar-log", { jobId: replacementId, line: "current log" });
      h.emit("sidecar-event", { job_id: replacementId, event: "completed", completed_videos: 2 });
      const completed = h.read();
      assert.equal(completed.jobId, replacementId);
      assert.equal(completed.status, "completed");
      assert.equal(completed.jobDirectory, "new/results");
      assert.deepEqual(completed.logs, ["current log"]);
    });
  }

  test(`completion before start ${outcome} remains completed`, async (t) => {
    const h = await mountJob(t);
    const start = h.read().start(config("fast-job"));
    h.emit("sidecar-event", { job_id: "fast-job", event: "completed", completed_videos: 2 });
    const completed = state(h.read());
    h.calls[0][outcome](outcome === "resolve" ? "fast-job" : new Error("late start failure"));
    await start;
    assert.deepEqual(state(h.read()), completed);
    assert.equal(h.read().status, "completed");
  });

  test(`delayed cancellation ${outcome} cannot change reset state`, async (t) => {
    const h = await mountJob(t);
    const start = h.read().start(config("old"));
    h.calls[0].resolve("old");
    await start;
    const cancel = h.read().cancel();
    assert.equal(h.calls[1].command, "cancel_analysis");
    assert.deepEqual(h.calls[1].args, { jobId: "old" });
    h.read().reset();
    const idle = state(h.read());
    h.calls[1][outcome](outcome === "resolve" ? undefined : new Error("late cancel failure"));
    await cancel;
    assert.deepEqual(state(h.read()), idle);
  });
}
