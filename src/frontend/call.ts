// Typed wrapper around invoke(): the bridge may return the resolver's value directly or wrapped as { body, metadata }.
import { invoke } from '@forge/bridge';

export async function call<T>(name: string, payload?: Record<string, unknown>): Promise<T> {
  const r: any = await invoke(name, payload);
  return (r && typeof r === 'object' && 'body' in r && 'metadata' in r ? r.body : r) as T;
}
