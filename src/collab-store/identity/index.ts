export { resolveParticipant, resolveTokenParticipant, unregisteredParticipantId, type ParticipantIdentity } from './resolve';
export { recordClientSighting, sightedClientIds } from './client-sightings';
export { authorizeAppend, authorizePhaseAdvance, UNREGISTERED_ALLOWED_TYPES } from './guard';
export {
  logicalIdentityOf, equivalentParticipantIds, participantsEquivalent,
  assertDistinctLogicalParticipants, listIdentityFamilies, IDENTITY_FAMILY_RE,
  type IdentityFamily,
} from './families';
export {
  authorizationKey, normalizeAccessChannel, sameAuthorization,
  type AccessChannel,
} from './channel-parity';
