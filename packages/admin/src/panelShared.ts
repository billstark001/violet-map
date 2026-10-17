export const VANILLA_DIMENSIONS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end'];

export function authHeaders(token: string, headers: HeadersInit = {}): HeadersInit {
  return token ? { ...headers, authorization: `Bearer ${token}` } : headers;
}
