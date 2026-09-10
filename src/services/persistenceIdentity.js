/** Keep this deterministic repair in sync with the web workspace normalizer. */
function repairDuplicatePersistenceKeys(objects) {
  const groups = new Map();
  for (const object of objects) {
    if (!object?.persistenceKey) continue;
    const key = `${object.type}:${object.persistenceKey}`;
    groups.set(key, [...(groups.get(key) || []), object]);
  }
  const reserved = new Set(groups.keys());
  const replacements = new Map();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const object of ordered.slice(1)) {
      if (ordered.some((other) => other !== object && other.id === object.id)) continue;
      let key = `recovered:${object.id}`;
      while (reserved.has(`${object.type}:${key}`)) key += ':copy';
      reserved.add(`${object.type}:${key}`);
      replacements.set(object, key);
    }
  }
  return objects.map((object) => replacements.has(object)
    ? { ...object, persistenceKey: replacements.get(object) } : object);
}

// Older workspace snapshots sometimes omitted the client UUID. Their browser
// then used the Mongo row id as persistenceKey. That fallback is not a second
// identity: accept it only for the same scientific-paper instance and title.
// Two different client UUIDs (or a different paper/type/copy) remain conflicts.
function compatibleFallbackPaperIdentity(incoming, stored) {
  if (!incoming || !stored || incoming.id !== stored.id ||
      incoming.type !== 'GX.MAROScientificPaper' || incoming.type !== stored.type) return false;
  const normalizeTitle = value => typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase() : '';
  const title = normalizeTitle(incoming.title);
  if (!title || title !== normalizeTitle(stored.title)) return false;
  if ((incoming.syncSourceId || '') !== (stored.syncSourceId || '')) return false;
  const key = object => typeof object.persistenceKey === 'string'
    ? object.persistenceKey.trim() : '';
  const incomingKey = key(incoming);
  const storedKey = key(stored);
  return !incomingKey || incomingKey === incoming.id || !storedKey || storedKey === stored.id;
}

// Accept an old browser's keys only for copies already present in the stored
// board. New collisions and unrelated identity changes must still be rejected.
function repairLegacyIncomingKeys(incoming, stored) {
  const repaired = repairDuplicatePersistenceKeys(stored);
  const repairs = new Map(stored.flatMap((object, index) =>
    object.persistenceKey !== repaired[index].persistenceKey
      ? [[object.id, { previous: object, next: repaired[index] }]] : []));
  const storedById = new Map(repaired.map(object => [object.id, object]));
  return incoming.map((object) => {
    if (!object || typeof object !== 'object') return object;
    const repair = repairs.get(object.id);
    if (repair && object.type === repair.previous.type &&
        object.persistenceKey === repair.previous.persistenceKey) {
      return { ...object, persistenceKey: repair.next.persistenceKey };
    }
    const existing = storedById.get(object.id);
    if (existing?.persistenceKey && existing.persistenceKey !== existing.id &&
        compatibleFallbackPaperIdentity(object, existing)) {
      return { ...object, persistenceKey: existing.persistenceKey };
    }
    return object;
  });
}

module.exports = { repairDuplicatePersistenceKeys, repairLegacyIncomingKeys, compatibleFallbackPaperIdentity };
