import { createApp } from './app.ts';

// Only the environment decides when a run has finished. Until then, keep serving.
const registrationBudget = 20_000;
const requestBudget = 5_000;
const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const backoff = (failures: number) => Math.min(2_000, 250 * 2 ** Math.min(failures, 4));

async function announce(origin: string, port: number): Promise<void> {
  const deadline = performance.now() + registrationBudget;
  let failures = 0;

  while (performance.now() < deadline) {
    let status: number | undefined;
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(requestBudget, deadline - performance.now())))),
      });
      status = response.status;
      await response.body?.cancel();
    } catch {
      // Startup races and temporary connection failures share the same retry path.
    }

    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) {
      throw new Error(`registration rejected with HTTP ${status}`);
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await pause(Math.min(backoff(failures++), remaining));
  }
  throw new Error('registration did not succeed within 20 seconds');
}

async function followRun(origin: string): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch(`${origin}/done`, {
        signal: AbortSignal.timeout(requestBudget),
      });
      if (response.ok) {
        const result: unknown = await response.json();
        if (result !== null && typeof result === 'object' && 'done' in result && result.done === true) return;
      } else {
        await response.body?.cancel();
      }
    } catch {
      // A failed poll supplies no completion signal; leave the application running.
    }
    await pause(backoff(failures++));
  }
}

async function run(): Promise<void> {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!origin) throw new Error('MAKEFUN_ENV_URL is not set');

  const application = createApp();
  await new Promise<void>((resolve, reject) => {
    application.once('error', reject);
    // Let the OS choose the application's TCP port.
    application.listen(0, () => {
      application.off('error', reject);
      resolve();
    });
  });

  try {
    const binding = application.address();
    if (!binding || typeof binding === 'string') throw new Error('no TCP port was assigned');
    process.stdout.write(`[entry] listening on port ${binding.port}\n`);
    await announce(origin, binding.port);
    process.stdout.write('[entry] registered; awaiting completion\n');
    await followRun(origin);
  } finally {
    await new Promise<void>((resolve, reject) => {
      application.close((error) => error ? reject(error) : resolve());
    });
  }
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[entry] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
