import type { GoogleGenAI } from '@google/genai';
import { MODEL_REGISTRY, MUSIC_MODEL_LIMITATION } from '../config/models';
import { bucket } from './firebase';
import { JobFailure, toJobError } from './errors';
import { geminiDeveloperApi, genai } from './vertex';

/**
 * Lyria 3.5 music generation through the Interactions API (text and up to ten images in, MP3 audio plus
 * lyrics / structure text out). Lyria 3.5 is served by Vertex AI when Google enables it for the project,
 * otherwise by the Gemini Developer API with a server-side key. No other music model is ever used: when
 * neither surface serves Lyria 3.5 the job fails with the exact limitation and nothing is billed.
 */

export interface MusicResult {
  audio: Buffer;
  mimeType: string;
  /** Lyrics with timing and structure, caption and BPM exactly as the model returned them. */
  text: string;
  interactionId: string;
  usage: { input: number; output: number } | null;
  surface: 'vertex' | 'developer-api';
}

type Block = { type?: string; text?: string; data?: string; uri?: string; mime_type?: string };
type InteractionLike = { id: string; status: string; steps?: { type?: string; content?: Block[] }[]; output_audio?: Block; output_text?: string; errors?: { message?: string }[]; usage?: { total_input_tokens?: number; total_output_tokens?: number } };

export function isModelUnavailable(e: unknown): boolean {
  const err = toJobError(e);
  const msg = `${err.message} ${err.details ?? ''}`;
  return err.code === 'not_found' || /Unsupported model interaction|Publisher Model .* not found|does not have access|is not found for API version|not supported for/i.test(msg);
}

function unavailable(detail: string): JobFailure {
  return new JobFailure({ code: 'model_unavailable', message: MUSIC_MODEL_LIMITATION, retryable: false, details: detail.slice(0, 300) });
}

export function extractMusic(it: InteractionLike): { audio: Block | null; text: string } {
  const blocks = (it.steps ?? []).filter((s) => s.type === 'model_output' || !s.type).flatMap((s) => s.content ?? []);
  const audio = blocks.find((b) => b.type === 'audio' && (b.data || b.uri)) ?? (it.output_audio?.data || it.output_audio?.uri ? it.output_audio! : null);
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!.trim())
    .join('\n---\n');
  return { audio, text: text || (it.output_text ?? '').trim() };
}

/** Vertex AI refused Lyria 3.5 recently: skip the extra (free, refused) request for a while. */
let vertexRefusedAt = 0;
const VERTEX_RECHECK_MS = 6 * 60 * 60 * 1000;

async function run(ai: GoogleGenAI, input: unknown, allowBackground: boolean): Promise<InteractionLike> {
  const body = { model: MODEL_REGISTRY.music.id, input };
  if (allowBackground) {
    try {
      let it = (await ai.interactions.create({ ...body, background: true, store: true } as never)) as unknown as InteractionLike;
      const deadline = Date.now() + 20 * 60_000;
      while ((it.status === 'in_progress' || it.status === 'queued') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000));
        it = (await ai.interactions.get(it.id)) as unknown as InteractionLike;
      }
      return it;
    } catch (e) {
      if (!/background|store/i.test(String((e as Error)?.message ?? ''))) throw e;
    }
  }
  return (await ai.interactions.create(body as never)) as unknown as InteractionLike;
}

/** Which surface would serve Lyria 3.5 right now (for Settings → Models and estimates). */
export async function musicSurface(): Promise<'vertex' | 'developer-api' | null> {
  if (Date.now() - vertexRefusedAt >= VERTEX_RECHECK_MS) {
    try {
      await genai().models.get({ model: MODEL_REGISTRY.music.id });
      return 'vertex';
    } catch (e) {
      if (!isModelUnavailable(e)) throw e;
      vertexRefusedAt = Date.now();
    }
  }
  return (await geminiDeveloperApi()) ? 'developer-api' : null;
}

export async function generateMusic(input: { prompt: string; imagePaths: { storagePath: string; mimeType: string }[] }): Promise<MusicResult> {
  let it: InteractionLike | null = null;
  let surface: MusicResult['surface'] = 'vertex';
  const refusal: string[] = [];
  if (Date.now() - vertexRefusedAt >= VERTEX_RECHECK_MS) {
    try {
      const content = [{ type: 'text', text: input.prompt }, ...input.imagePaths.map((i) => ({ type: 'image', uri: `gs://${bucket.name}/${i.storagePath}`, mime_type: i.mimeType }))];
      it = await run(genai(), [{ type: 'user_input', content }], true);
    } catch (e) {
      if (!isModelUnavailable(e)) throw e;
      vertexRefusedAt = Date.now();
      refusal.push(`Vertex AI: ${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
  if (!it) {
    const dev = await geminiDeveloperApi();
    if (!dev) throw unavailable(refusal.join(' ') || 'Vertex AI does not serve lyria-3.5 and no Gemini API key is configured.');
    surface = 'developer-api';
    // The Gemini Developer API cannot read the private bucket: images are sent inline.
    const images = await Promise.all(input.imagePaths.map(async (i) => ({ type: 'image', mime_type: i.mimeType, data: (await bucket.file(i.storagePath).download())[0].toString('base64') })));
    try {
      it = await run(dev, images.length ? [{ type: 'text', text: input.prompt }, ...images] : input.prompt, false);
    } catch (e) {
      if (isModelUnavailable(e)) throw unavailable(`Gemini API: ${String((e as Error)?.message ?? e)}`);
      throw e;
    }
  }
  if (it.status && it.status !== 'completed') {
    const msg = (it.errors ?? []).map((x) => x.message).filter(Boolean).join(' ');
    throw new JobFailure({ code: 'music_failed', message: `Lyria did not finish the music (${it.status}).${msg ? ` ${msg.slice(0, 300)}` : ''}`, retryable: false });
  }
  const { audio, text } = extractMusic(it);
  if (!audio) throw new JobFailure({ code: 'no_audio', message: 'Lyria returned no audio.', retryable: false, details: text.slice(0, 400) });
  if (!audio.data) throw new JobFailure({ code: 'unexpected_output', message: `Lyria returned the audio by URI (${audio.uri}), which AZ Studio cannot read.`, retryable: false });
  return {
    audio: Buffer.from(audio.data, 'base64'),
    mimeType: audio.mime_type ?? 'audio/mpeg',
    text,
    interactionId: it.id,
    usage: it.usage ? { input: it.usage.total_input_tokens ?? 0, output: it.usage.total_output_tokens ?? 0 } : null,
    surface,
  };
}
