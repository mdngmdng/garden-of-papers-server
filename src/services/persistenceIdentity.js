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

// Accept an old browser's keys only for copies already present in the stored
// board. New collisions and unrelated identity changes must still be rejected.
function repairLegacyIncomingKeys(incoming, stored) {
  const repaired = repairDuplicatePersistenceKeys(stored);
  const repairs = new Map(stored.flatMap((object, index) =>
    object.persistenceKey !== repaired[index].persistenceKey
      ? [[object.id, { previous: object, next: repaired[index] }]] : []));
  return incoming.map((object) => {
    if (!object || typeof object !== 'object') return object;
    const repair = repairs.get(object.id);
    return repair && object.type === repair.previous.type &&
      object.persistenceKey === repair.previous.persistenceKey
      ? { ...object, persistenceKey: repair.next.persistenceKey } : object;
  });
}

module.exports = { repairDuplicatePersistenceKeys, repairLegacyIncomingKeys };
