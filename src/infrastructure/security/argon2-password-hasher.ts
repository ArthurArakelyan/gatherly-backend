import argon2 from 'argon2';

const options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export class Argon2PasswordHasher {
  public hash(password: string): Promise<string> {
    return argon2.hash(password, options);
  }

  public async verify(passwordHash: string, password: string): Promise<boolean> {
    if (!passwordHash.startsWith('$argon2id$')) return false;

    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  }
}
