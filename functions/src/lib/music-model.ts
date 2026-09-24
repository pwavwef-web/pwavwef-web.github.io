import { MODEL_REGISTRY, MUSIC_MODEL_LIMITATION } from '../config/models';
import { gsUri } from './firebase';
import { JobFailure, toJobError } from './errors';
import { genai } from './vertex';

/**
 * Lyria 3.5 music generation through the Interactions API (the documented request shape: text and up
 * to ten images in, MP3 audio plus timed lyrics / song structure text out). No other music model is
 * ever substituted: when Vertex AI does not serve the registry music model for the project, the job fails with the
 * exact limitation and nothing is billed.
 */

export interface MusicResult {
  audio: Buffer;
  mimeType: string;
  /** Lyrics with timing and structure, caption and BPM exactly as the model returned them. */
  text: string;
  interactionId: string;
  usage: { input: number; output: number } | null;
}

type Block = { type?: string; text?: string; data?: string; uri?: string; mime_type?: string };
type InteractionLike = { id: string; status: string; steps?: { type?: string; content?: Block[] }[]; output_audio?: Block; errors?: { message?: string }[]; usage?: { total_input_tokens?: number; total_output_tokens?: number } };

export function isModelUnavailable(e: unknown): boolean {
  const err = toJobError(e);
  const msg = `${err.message} ${err.details ?? ''}`;
  return err.code === 'not_found' || /Unsupported model interaction|Publisher Model .* not found|does not have access/i.test(msg);
}

function unavailable(e: unknown): JobFailure {
  const detail = String((e as Error)?.message ?? e).slice(0, 300);
  return new JobFailure({ code: 'model_unavailable', message: MUSIC_MODEL_LIMITATION, retryable: false, details: detail });
}

export function extractMusic(it: InteractionLike): { audio: Block | null; text: string } {
  const blocks = (it.steps ?? []).filter((s) => s.type === 'model_output' || !s.type).flatMap((s) => s.content ?? []);
  const audio = blocks.find((b) => b.type === 'audio' && (b.data || b.uri)) ?? (it.output_audio?.data || it.output_audio?.uri ? it.output_audio! : null);
  const text = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!.trim())
    .join('\n---\n');
  return { audio, text };
}

export async function generateMusic(input: { prompt: string; imagePaths: { storagePath: string; mimeType: string }[] }): Promise<MusicResult> {
  const content: Record<string, unknown>[] = [{ type: 'text', text: input.prompt }, ...input.imagePaths.map((i) => ({ type: 'image', uri: gsUri(i.storagePath), mime_type: i.mimeType }))];
  const body = { model: MODEL_REGISTRY.music.id, input: [{ type: 'user_input', content }] };
  let it: InteractionLike;
  try {
    try {
      // Long songs: run in the background and poll when the model supports it.
      it = (await genai().interactions.create({ ...body, background: true, store: true } as never)) as unknown as InteractionLike;
      const deadline = Date.now() + 20 * 60_000;
      while ((it.status === 'in_progress' || it.status === 'queued') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 6000));
        it = (await genai().interactions.get(it.id)) as unknown as InteractionLike;
      }
    } catch (e) {
      if (!/background/i.test(String((e as Error)?.message ?? ''))) throw e;
      it = (await genai().interactions.create(body as never)) as unknown as InteractionLike;
    }
  } catch (e) {
    if (isModelUnavailable(e)) throw unavailable(e);
    throw e;
  }
  if (it.status !== 'completed') {
    const msg = (it.errors ?? []).map((x) => x.message).filter(Boolean).join(' ');
    throw new JobFailure({ code: 'music_failed', message: `Lyria did not finish the music (${it.status}).${msg ? ` ${msg.slice(0, 300)}` : ''}`, retryable: false });
  }
  const { audio, text } = extractMusic(it);
  if (!audio) throw new JobFailure({ code: 'no_audio', message: 'Lyria returned no audio.', retryable: false, details: text.slice(0, 400) });
  let bytes: Buffer;
  if (audio.data) bytes = Buffer.from(audio.data, 'base64');
  else throw new JobFailure({ code: 'unexpected_output', message: `Lyria returned the audio by URI (${audio.uri}), which AZ Studio cannot read.`, retryable: false });
  return {
    audio: bytes,
    mimeType: audio.mime_type ?? 'audio/mpeg',
    text,
    interactionId: it.id,
    usage: it.usage ? { input: it.usage.total_input_tokens ?? 0, output: it.usage.total_output_tokens ?? 0 } : null,
  };
}
