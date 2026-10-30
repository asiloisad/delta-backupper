const names = { F: 'full', I: 'incremental', D: 'differential' };
const letters = { full: 'F', incremental: 'I', differential: 'D' };

/** The JSON format uses the same compact sequence shown in the editor. */
export function sequenceFromString(value) {
  if (typeof value !== 'string' || !/^F[FID]*$/.test(value)) throw new Error('sequence: expected F followed by zero or more F, I or D letters');
  return { types: [...value].map(letter => names[letter]) };
}

export function sequenceToString(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.types) || value.types.some(type => !Object.hasOwn(letters, type))) throw new Error('sequence: expected full, incremental or differential backup types');
  const result = value.types.map(type => letters[type]).join('');
  sequenceFromString(result);
  return result;
}
