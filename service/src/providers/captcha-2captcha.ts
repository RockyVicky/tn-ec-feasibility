/**
 * Minimal 2Captcha client for solving a normal (distorted-text) image
 * CAPTCHA. Completely separate from the existing HITL flow in
 * automation-worker.ts — this module is only ever called when a caller
 * opts in by passing an API key; it does not touch ctx.requestHuman or any
 * of the existing console-operator machinery.
 *
 * API docs: https://2captcha.com/2captcha-api
 */

export interface TwoCaptchaConfig {
  apiKey: string;
  /** How often to poll for the answer. 2Captcha's own guidance is ~5s. */
  pollIntervalMs?: number;
  /** Give up and throw after this long. */
  timeoutMs?: number;
}

interface TwoCaptchaResponse {
  status: 0 | 1;
  request: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Submits a base64-encoded CAPTCHA image to 2Captcha and polls until it's
 * solved. Throws on any submit error, poll error, or timeout — callers are
 * expected to catch and fall back to a human (see automation-worker.ts).
 */
export async function solveImageCaptcha(imageBase64: string, cfg: TwoCaptchaConfig): Promise<string> {
  const pollIntervalMs = cfg.pollIntervalMs ?? 5000;
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  // Callers pass either a raw base64 string or a data URL
  // ("data:image/png;base64,...") — strip the prefix if present.
  const commaIdx = imageBase64.indexOf(",");
  const body = imageBase64.startsWith("data:") && commaIdx !== -1 ? imageBase64.slice(commaIdx + 1) : imageBase64;

  const submitRes = await fetch("https://2captcha.com/in.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key: cfg.apiKey, method: "base64", body, json: "1" }),
  });
  const submitBody = (await submitRes.json()) as TwoCaptchaResponse;
  if (submitBody.status !== 1) throw new Error(`2captcha submit failed: ${submitBody.request}`);
  const taskId = submitBody.request;

  // 2Captcha needs a few seconds to actually solve it — polling immediately
  // just wastes a round trip on a guaranteed CAPCHA_NOT_READY.
  await sleep(5000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pollRes = await fetch(`https://2captcha.com/res.php?key=${cfg.apiKey}&action=get&id=${taskId}&json=1`);
    const pollBody = (await pollRes.json()) as TwoCaptchaResponse;
    if (pollBody.status === 1) return pollBody.request;
    if (pollBody.request !== "CAPCHA_NOT_READY") throw new Error(`2captcha poll failed: ${pollBody.request}`);
    await sleep(pollIntervalMs);
  }
  throw new Error("2captcha timed out waiting for a solved answer");
}
