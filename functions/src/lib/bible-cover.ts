import { createHash } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import type { CharacterDoc, ProjectDoc } from '@az-studio/shared';
import { col, db } from './firebase';
import { COVER_REFERENCE_LIMIT, projectCoverRequest } from './project-cover';

export const characterCoverRef = (c: CharacterDoc): string | null => (c.bible?.approvedAt ? c.bible.approvedRefIds[0] : null) || c.primaryRefAssetId || c.bible?.refs.front || null;

export function bibleCoverSignature(project: ProjectDoc, characters: CharacterDoc[]): string {
  return createHash('sha256').update(JSON.stringify({
    projectId: project.id, title: project.title, idea: project.idea, logline: project.logline,
    treatment: project.treatment?.body, style: project.styleBible,
    characters: [...characters].sort((a, b) => a.id.localeCompare(b.id)).map(c => ({id: c.id, name: c.name, appearance: c.appearance, wardrobe: c.wardrobe, realPerson: Boolean(c.realPerson), consentConfirmed: Boolean(c.consentConfirmed), ref: characterCoverRef(c)})),
  })).digest('hex');
}

/** A Bible cover never invents a substitute likeness for a character without a ready reference. */
export async function loadBibleCover(uid: string, projectId: string) {
  const snap = await col.projects().doc(projectId).get();
  if (!snap.exists || snap.get('ownerUid') !== uid) throw new HttpsError('not-found', 'Project not found.');
  const project = { ...snap.data(), id: snap.id } as ProjectDoc;
  const chars = await col.sub(projectId, 'characters').get();
  const characters = chars.docs.map(d => ({...d.data(), id: d.id} as CharacterDoc)).sort((a, b) => a.id.localeCompare(b.id));
  if (!characters.length) throw new HttpsError('failed-precondition', 'Add characters and generate their likeness references in the Bible first.');
  const missing = characters.filter(c => !characterCoverRef(c));
  if (missing.length) throw new HttpsError('failed-precondition', `Generate a likeness reference for ${missing.map(c => c.name || c.id).join(', ')} before making the project cover.`);
  const blocked = characters.find(c => c.realPerson && !c.consentConfirmed);
  if (blocked) throw new HttpsError('failed-precondition', `Confirm ${blocked.name}'s consent in the Character Bible first.`);
  const ids = [...new Set(characters.map(c => characterCoverRef(c)!))];
  const assets = await db.getAll(...ids.map(id => col.assets().doc(id)));
  if (assets.some(a => !a.exists || a.get('ownerUid') !== uid || a.get('kind') !== 'image' || a.get('status') !== 'ready')) throw new HttpsError('failed-precondition', 'Wait for every character likeness image to be ready before making the cover.');
  const chosenIds = ids.slice(0, COVER_REFERENCE_LIMIT);
  const chosen = characters.filter(c => chosenIds.includes(characterCoverRef(c)!));
  const request = projectCoverRequest(project, {characters: chosen.map(c => ({ name: c.name, role: c.role, appearance: c.appearance, wardrobe: c.wardrobe, reference: chosenIds.indexOf(characterCoverRef(c)!) + 1 }))}, chosenIds);
  request.prompt = 'Preserve the exact facial identity, skin tone, hair and build of every depicted character from their numbered reference image. Depict only characters whose reference images are supplied; do not invent replacement faces.\n' + request.prompt;
  request.bibleCover = true;
  request.characterIds = chosen.map(c => c.id).slice(0, 10);
  return { project, characters, signature: bibleCoverSignature(project, characters), request };
}
