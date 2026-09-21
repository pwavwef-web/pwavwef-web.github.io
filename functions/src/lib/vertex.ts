import { GoogleGenAI } from '@google/genai';
import { PROJECT_ID } from '../config/runtime';
import { MODEL_REGISTRY } from '../config/models';

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
