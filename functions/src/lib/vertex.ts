import { GoogleGenAI } from '@google/genai';
import { PROJECT_ID } from '../config/runtime';
import { MODEL_REGISTRY } from '../config/models';
import { readOptionalSecret } from './secrets';

let client: GoogleGenAI | null = null;

/**
 * Google Gen AI SDK configured for Vertex AI (enterprise mode). Authenticates with the function's
 * service account through Application Default Credentials — no API keys, nothing reaches the browser.
 */
export function genai(): GoogleGenAI {
  if (!client) {
    client = new GoogleGenAI({ enterprise: true, project: PROJECT_ID, location: MODEL_REGISTRY.video.location });
  }
  return client;
}

let developer: { client: GoogleGenAI; key: string } | null = null;

/**
 * The Gemini Developer API (ai.google.dev), used only for models Vertex AI does not serve to this
 * project (Lyria 3.5). The API key lives in Secret Manager and is used server-side only; returns null
 * when no key is configured.
 */
export async function geminiDeveloperApi(): Promise<GoogleGenAI | null> {
  const key = await readOptionalSecret(MODEL_REGISTRY.music.apiKeySecret);
  if (!key) return null;
  if (!developer || developer.key !== key) developer = { client: new GoogleGenAI({ apiKey: key }), key };
  return developer.client;
}
