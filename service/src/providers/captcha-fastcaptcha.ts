/**
 * Minimal FastCaptcha client for solving a text/image CAPTCHA. Separate
 * from both the 2Captcha and NopeCHA paths in automation-worker.ts — this
 * module is only ever called when a caller opts in with an API key.
 *
 * API docs: https://fastcaptcha.org/docs, https://fastcaptcha.org/api-docs/
 * Synchronous (no submit/poll): one POST returns the solved text directly.
 */

export interface FastCaptchaConfig {
  apiKey: string;
}

interface FastCaptchaResponse {
  success: boolean;
  text?: string;
  confidence?: number;
  model_used?: string;
  processing_time?: number;
  credits_remaining?: number;
  ml_available?: boolean;
}

/**
 * Submits a base64-encoded CAPTCHA image and returns the solved text.
 * Throws on any non-success response — callers are expected to catch and
 * fall back (to 2Captcha or a human); see automation-worker.ts.
 */
export async function solveImageCaptchaFastCaptcha(imageBase64: string, cfg: FastCaptchaConfig): Promise<string> {
  const res = await fetch("https://fastcaptcha.org/api/v1/ocr/", {
    method: "POST",
    headers: { "X-API-Key": cfg.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ base64_image: imageBase64 }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<FastCaptchaResponse>;
  if (!res.ok || !body.success || !body.text) {
    throw new Error(`fastcaptcha solve failed: HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body.text;
}
