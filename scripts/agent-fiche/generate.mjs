#!/usr/bin/env node
/**
 * CC-7 F1 — régénération déterministe de l'artefact dérivé de la fiche canonique des agents.
 * Source : config/agents.fiche.json → src/collab-store/agentrun/generated/agent-fiche.generated.ts.
 * Aucune horloge, aucune entrée hors de la fiche : deux exécutions produisent le même contenu.
 * Node >= 23.6 requis (stripping de types pour importer src/collab-store/agentrun/fiche.ts).
 *
 *   node scripts/agent-fiche/generate.mjs          régénère l'artefact s'il a divergé (sortie 0)
 *   node scripts/agent-fiche/generate.mjs --check  contrôle sans écrire : sortie 1 si divergence
 *
 * La CI ne dépend pas de ce script : cc7-f1-fiche-canonical.spec.ts applique le même contrôle fail-on-diff.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fnv1a64, parseFiche, renderGeneratedArtifact } from '../../src/collab-store/agentrun/fiche.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fichePath = join(root, 'config', 'agents.fiche.json');
const artifactPath = join(root, 'src', 'collab-store', 'agentrun', 'generated', 'agent-fiche.generated.ts');

const raw = readFileSync(fichePath, 'utf8');
const fiche = parseFiche(raw);
const expected = renderGeneratedArtifact(fiche, raw);
const current = readFileSync(artifactPath, 'utf8');
const hash = fnv1a64(raw);

if (current === expected) {
	console.log('agent-fiche : artefact à jour (fiche v' + fiche.version + ', hash ' + hash + ').');
	process.exit(0);
}
if (process.argv.includes('--check')) {
	console.error('agent-fiche : artefact divergent — exécutez `node scripts/agent-fiche/generate.mjs` puis commettez fiche et artefact ensemble (hash attendu ' + hash + ').');
	process.exit(1);
}
writeFileSync(artifactPath, expected);
console.log("agent-fiche : artefact régénéré (fiche v" + fiche.version + ", hash " + hash + ") — commettez config/agents.fiche.json et l'artefact ensemble.");
