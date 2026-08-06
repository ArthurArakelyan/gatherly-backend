import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';

import { AppError } from '../../shared/errors/app-error.js';

interface AccessTokenConfiguration {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

const tokenPayloadSchema = z.object({
  sub: z.uuid(),
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number().int(),
  iat: z.number().int(),
});

export class JwtAccessTokens {
  public constructor(private readonly configuration: AccessTokenConfiguration) {}

  public sign(userId: string): string {
    return jwt.sign({}, this.configuration.secret, {
      algorithm: 'HS256',
      subject: userId,
      issuer: this.configuration.issuer,
      audience: this.configuration.audience,
      expiresIn: this.configuration.ttlSeconds,
    });
  }

  public verify(token: string): string {
    let decoded: string | JwtPayload;

    try {
      decoded = jwt.verify(token, this.configuration.secret, {
        algorithms: ['HS256'],
        issuer: this.configuration.issuer,
        audience: this.configuration.audience,
      });
    } catch {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }

    const result = tokenPayloadSchema.safeParse(decoded);
    if (!result.success) {
      throw new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required');
    }

    return result.data.sub;
  }
}
