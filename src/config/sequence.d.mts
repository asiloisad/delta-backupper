import type { TaskSettings } from '../domain/models.js';
export function sequenceFromString(value: unknown): TaskSettings['sequence'];
export function sequenceToString(value: TaskSettings['sequence']): string;
