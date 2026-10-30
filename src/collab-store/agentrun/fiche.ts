/**
 * CC-7 F1 (P3 #1138 §1, rôles ratifiés par Kevin #1139) — fiche canonique unique par agent logique.
 *
 * Source unique des DÉFINITIONS de modèles : le fichier typé versionné config/agents.fiche.json,
 * modifié seulement par PR (D12). Les variables wrangler AGENT_RUN_* en sont DÉRIVÉES
 * (deriveAgentRunVars) ; l'artefact src/collab-store/agentrun/generated/agent-fiche.generated.ts
 * est régénéré par scripts/agent-fiche/generate.mjs ; la CI échoue si la fiche, l'artefact ou
 * wrangler.jsonc (env cc3-test) divergent — fail-on-diff byte-exact, spec
 * test/collab-store/agentrun/cc7-f1-fiche-canonical.spec.ts.
 *
 * D1 = overrides opérationnels seulement (activation, budgets, références de clés) et audit :
 * jamais une seconde définition des modèles. Secrets, budgets et attestations HORS fiche
 * (environnement owner). Anciens ep-* = alias immuables : cibles épinglées, jamais réaffectées.
 *
 * Migration en lecture parallèle (F1) : le runtime lit TOUJOURS les variables d'environnement ;
 * la fiche n'est pas encore la source d'exécution. Seul le journal des choix serveur gagne le
 * tampon version + hash de la fiche (provider-models.ts → agent_model_choices).
 *
 * Module PUR SANS IMPORT, partagé par le Worker, la spec F1 et le script de génération
 * (Node >= 23.6 : stripping de types — aucune syntaxe non effaçable ici).
 */

/** Niveaux d'un agent ; l'ordre des modèles de la fiche est l'ordre de la politique (fort → léger). */
export const FICHE_ROLES = ['fort', 'rapide', 'leger', 'gratuit'] as const;
export type FicheRole = typeof FICHE_ROLES[number];

export const ENDPOINT_STATUSES = ['registered', 'proposed'] as const;
export type FicheEndpointStatus = typeof ENDPOINT_STATUSES[number];

export interface FicheModel {
	readonly role: FicheRole;
	/** Référence épinglée <fournisseur>:<modèle> — jamais un alias flottant du fournisseur (C2). */
	readonly ref: string;
}

export interface FicheEndpoint {
	/** Identifiant historique ep-* : immuable, jamais réutilisé pour une autre cible. */
	readonly endpoint_id: string;
	/** Cible épinglée ; l'inscription / l'activation reste un acte owner (/owner), pas la fiche. */
	readonly ref: string;
	readonly status: FicheEndpointStatus;
	/** Exigé vrai par le parseur : tout alias ep-* est immuable (F1). */
	readonly immutable_alias: boolean;
}

export interface FicheAgent {
	/** Agent logique stable (P3 §1 : claude, gpt, grok, vibe, gemini). */
	readonly id: string;
	/** Participant du store, suffixe des variables AGENT_RUN_*_<PARTICIPANT> (ex. gpt → gpt6). */
	readonly participant_id: string;
	readonly family: string;
	/** true = dérivé dans AGENT_RUN_PARTICIPANTS ; false = variables préparées, agent non activé. */
	readonly active: boolean;
	readonly models: readonly FicheModel[];
	readonly endpoints: readonly FicheEndpoint[];
}

export interface Fiche {
	/** Incrémentée à chaque modification ; journalisée avec le hash à chaque choix serveur. */
	readonly version: number;
	/** Repli global AGENT_RUN_MODEL (participants sans politique), épinglé lui aussi. */
	readonly global_fallback_model: string;
	readonly agents: readonly FicheAgent[];
}

const REF_RE = /^[a-z][a-z-]{1,15}:\S{1,200}$/;
const ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const EP_RE = /^ep-[a-z0-9][a-z0-9-]{0,39}$/;

function invalid(detail: string): Error {
	return new Error('FICHE_INVALID : ' + detail);
}

function asObject(value: unknown, detail: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(detail);
	return value as Record<string, unknown>;
}

/** Parse et valide la fiche canonique ; toute erreur = fiche refusée en entier (deny-by-default). */
export function parseFiche(raw: string): Fiche {
	const root = asObject(JSON.parse(raw), 'racine de fiche invalide.');
	const version = root.version;
	if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw invalid('version absente ou invalide.');
	const globalFallback = root.global_fallback_model;
	if (typeof globalFallback !== 'string' || !REF_RE.test(globalFallback)) throw invalid('global_fallback_model absent ou mal formé.');
	if (!Array.isArray(root.agents) || root.agents.length === 0) throw invalid('aucun agent.');
	const agents: FicheAgent[] = [];
	const ids = new Set<string>();
	const participants = new Set<string>();
	const endpointIds = new Set<string>();
	for (const entry of root.agents) {
		const agent = asObject(entry, 'agent malformé.');
		const id = agent.id;
		if (typeof id !== 'string' || !ID_RE.test(id)) throw invalid('id d’agent invalide.');
		const participantId = agent.participant_id;
		if (typeof participantId !== 'string' || !ID_RE.test(participantId)) throw invalid('participant_id invalide pour ' + id + '.');
		const family = agent.family;
		if (typeof family !== 'string' || !/^[a-z]+$/.test(family)) throw invalid('famille invalide pour ' + id + '.');
		const active = agent.active;
		if (typeof active !== 'boolean') throw invalid('active absent pour ' + id + '.');
		if (ids.has(id)) throw invalid('id d’agent en double : ' + id + '.');
		if (participants.has(participantId)) throw invalid('participant_id en double : ' + participantId + '.');
		if (!Array.isArray(agent.models) || agent.models.length === 0) throw invalid('aucun modèle pour ' + id + '.');
		const models: FicheModel[] = [];
		const refs = new Set<string>();
		for (const modelEntry of agent.models) {
			const model = asObject(modelEntry, 'modèle malformé pour ' + id + '.');
			const role = model.role;
			if (typeof role !== 'string' || !(FICHE_ROLES as readonly string[]).includes(role)) throw invalid('niveau inconnu pour ' + id + ' : ' + role + '.');
			const ref = model.ref;
			if (typeof ref !== 'string' || !REF_RE.test(ref)) throw invalid('référence invalide pour ' + id + ' : ' + String(ref) + '.');
			if (refs.has(ref)) throw invalid('modèle en double pour ' + id + ' : ' + ref + '.');
			refs.add(ref);
			models.push({ role: role as FicheRole, ref });
		}
		const endpoints: FicheEndpoint[] = [];
		const endpointList = Array.isArray(agent.endpoints) ? agent.endpoints : [];
		for (const endpointEntry of endpointList) {
			const endpoint = asObject(endpointEntry, 'endpoint malformé pour ' + id + '.');
			const endpointId = endpoint.endpoint_id;
			if (typeof endpointId !== 'string' || !EP_RE.test(endpointId)) throw invalid('endpoint_id invalide pour ' + id + '.');
			if (endpointIds.has(endpointId)) throw invalid('endpoint_id en double : ' + endpointId + '.');
			const ref = endpoint.ref;
			if (typeof ref !== 'string' || !REF_RE.test(ref) || !refs.has(ref)) throw invalid('endpoint ' + endpointId + ' : cible absente des modèles de ' + id + '.');
			const status = endpoint.status;
			if (typeof status !== 'string' || !(ENDPOINT_STATUSES as readonly string[]).includes(status)) throw invalid('statut d’endpoint inconnu : ' + String(status) + '.');
			if (endpoint.immutable_alias !== true) throw invalid('tout alias ep-* est immuable (immutable_alias requis) : ' + endpointId + '.');
			endpointIds.add(endpointId);
			endpoints.push({ endpoint_id: endpointId, ref, status: status as FicheEndpointStatus, immutable_alias: true });
		}
		ids.add(id);
		participants.add(participantId);
		agents.push({ id, participant_id: participantId, family, active, models, endpoints });
	}
	if (!agents.some(agent => agent.active)) throw invalid('aucun agent actif (AGENT_RUN_PARTICIPANTS vide).');
	return { version, global_fallback_model: globalFallback, agents };
}

/** Suffixe de variable d'un participant — miroir de participantModelVar (provider-models.ts), sans import. */
export function participantSuffix(participantId: string): string {
	return participantId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/** Variables wrangler publiques DÉRIVÉES de la fiche (définitions de modèles uniquement ; ni budgets ni attestations). */
export function deriveAgentRunVars(fiche: Fiche): Record<string, string> {
	const vars: Record<string, string> = {
		AGENT_RUN_MODEL: fiche.global_fallback_model,
		AGENT_RUN_PARTICIPANTS: fiche.agents.filter(agent => agent.active).map(agent => agent.participant_id).join(','),
	};
	for (const agent of fiche.agents) {
		vars['AGENT_RUN_FAMILY_' + participantSuffix(agent.participant_id)] = agent.family;
		vars['AGENT_RUN_MODELS_' + participantSuffix(agent.participant_id)] = agent.models.map(model => model.ref).join(',');
	}
	return vars;
}

/** Alias ep-* de la fiche : endpoint → agent logique et cible épinglée (immuable). */
export interface FicheAlias {
	readonly endpoint_id: string;
	readonly agent_id: string;
	readonly ref: string;
	readonly status: FicheEndpointStatus;
}

export function ficheAliases(fiche: Fiche): readonly FicheAlias[] {
	const aliases: FicheAlias[] = [];
	for (const agent of fiche.agents) {
		for (const endpoint of agent.endpoints) {
			aliases.push({ endpoint_id: endpoint.endpoint_id, agent_id: agent.id, ref: endpoint.ref, status: endpoint.status });
		}
	}
	return aliases;
}

/** Empreinte FNV-1a 64 bits (UTF-8) du contenu exact de la fiche : identité de version, pas un secret. */
export function fnv1a64(text: string): string {
	const prime = 0x100000001b3n;
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < text.length; index++) {
		let code = text.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
			const low = text.charCodeAt(index + 1);
			if (low >= 0xdc00 && low <= 0xdfff) {
				code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
				index++;
			}
		}
		const bytes = code < 0x80 ? [code]
			: code < 0x800 ? [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
				: code < 0x10000 ? [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
					: [0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)];
		for (const byte of bytes) {
			hash ^= BigInt(byte);
			hash = (hash * prime) & 0xffffffffffffffffn;
		}
	}
	return hash.toString(16).padStart(16, '0');
}

/** Tampon journalisé avec chaque choix serveur : version et hash de la fiche (P3 #1138 §1). */
export function ficheStamp(version: number, hash: string): string {
	return ' ; fiche v' + version + ' ' + hash;
}

/** Contenu exact de l'artefact généré generated/agent-fiche.generated.ts (déterministe, aucune horloge). */
export function renderGeneratedArtifact(fiche: Fiche, raw: string): string {
	const json = raw.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\\${');
	const vars = Object.entries(deriveAgentRunVars(fiche)).map(([key, value]) => '\t' + key + ': ' + JSON.stringify(value) + ',').join('\n');
	return [
		'/**',
		' * ARTIFACT GÉNÉRÉ — NE PAS ÉDITER À LA MAIN.',
		' * Source unique : config/agents.fiche.json (CC-7 F1, fiche canonique des agents).',
		' * Régénéré par scripts/agent-fiche/generate.mjs ; la CI échoue si cet artefact, la fiche ou',
		' * les variables AGENT_RUN_* de wrangler.jsonc divergent (cc7-f1-fiche-canonical.spec.ts).',
		' */',
		'',
		'/** Version de la fiche canonique (journalisée avec chaque choix serveur). */',
		'export const FICHE_VERSION = ' + fiche.version + ';',
		'',
		'/** Empreinte FNV-1a 64 du contenu exact de la fiche (identité de version, pas un secret). */',
		'export const FICHE_HASH = ' + JSON.stringify(fnv1a64(raw)) + ';',
		'',
		'/** Contenu exact de la fiche canonique (audit : version et hash se recomptent depuis ici). */',
		'export const FICHE_RAW = `' + json + '`;',
		'',
		'/** Variables wrangler AGENT_RUN_* dérivées de la fiche (définitions de modèles uniquement). */',
		'export const AGENT_RUN_VARS: Readonly<Record<string, string>> = Object.freeze({',
		vars,
		'});',
		'',
	].join('\n');
}
