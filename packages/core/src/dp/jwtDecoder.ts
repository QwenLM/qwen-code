export interface JwtPayload {
  exp?: number;
  iat?: number;
  iss?: string;
  sub?: string;
  preferred_username?: string;
  email?: string;
  [key: string]: unknown;
}

export function decodeJwt(token: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT: expected 3 parts');
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload) as JwtPayload;
  } catch (error) {
    throw new Error('Failed to decode JWT payload', { cause: error });
  }
}

export function getJwtExpiryMs(token: string): number {
  const payload = decodeJwt(token);
  if (typeof payload.exp !== 'number') {
    throw new Error('Invalid JWT: missing numeric exp claim');
  }
  return payload.exp * 1000;
}
